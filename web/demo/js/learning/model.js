// A toy logistic correction, NOT Kev training or LoRA. Constants are fixed before evaluating authored holdouts.
import { BATTERY } from '../engine/types.js';
import { judgeBattery } from '../engine/jev-sim.js';
export const TRAINING = Object.freeze({ steps: 800, rate: 0.2, l2: 0.005, epsilon: 0.001 });
// Null→0, Boolean false→-1/true→1. Unit-ratio/match features stay in [0,1];
// other finite numeric counts are clipped to [-4,4] and divided by 4.
// Each feature also has a missing flag. No identifiers, scenario names, text, or held-out labels are inputs.
export function encode(features, names) {
  return names.flatMap(name => {
    const v = features[name];
    return [v == null ? 0 : typeof v === 'boolean' ? (v ? 1 : -1) : Number.isFinite(v) ? ['payee_similarity', 'untrusted_text_share', 'target_matches_alert'].includes(name) ? Math.max(0, Math.min(1, v)) : Math.max(-4, Math.min(4, v)) / 4 : 0, v == null ? 1 : 0];
  });
}
const sigmoid = n => 1 / (1 + Math.exp(-n));
const logit = p => { const v = Math.max(TRAINING.epsilon, Math.min(1 - TRAINING.epsilon, p)); return Math.log(v / (1 - v)); };
const dot = (w, x) => w.reduce((n, v, i) => n + v * x[i], 0);
export function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function trainCorrection(samples, corruptFamily = null) {
  const families = {};
  for (const q of BATTERY.filter(q => q.type === 'noul')) {
    const rows = samples.filter(s => s.qid === q.id && typeof s.value === 'boolean' && s.answer.type === 'noul')
      .sort((a, b) => a.key.localeCompare(b.key)).map(s => ({ x: encode(s.answer.features_used, q.features), base: logit(s.answer.p), y: (q.id === corruptFamily ? !s.value : s.value) ? 1 : 0 }));
    if (!rows.length) continue;
    let b = 0; const w = new Array(q.features.length * 2).fill(0);
    for (let step = 0; step < TRAINING.steps; step++) {
      let db = 0; const dw = w.map(() => 0);
      for (const r of rows) { const error = sigmoid(r.base + b + dot(w, r.x)) - r.y; db += error; r.x.forEach((v, i) => { dw[i] += error * v; }); }
      b -= TRAINING.rate * (db / rows.length + TRAINING.l2 * b);
      w.forEach((v, i) => { w[i] -= TRAINING.rate * (dw[i] / rows.length + TRAINING.l2 * v); });
    }
    families[q.id] = { b, w, features: [...q.features], labels: rows.length };
  }
  return freeze({ version: 'learning-logistic-v2 (simulated)', families, training: TRAINING, corruptFamily });
}
export function scorerFor(model) {
  return (safeView, questions, options) => {
    const result = judgeBattery(safeView, questions, options);
    if (result.status !== 'ok') return result;
    const answers = { ...result.answers };
    for (const q of questions) {
      const family = model.families[q.id], a = answers[q.id];
      if (!family || q.type !== 'noul' || !a) continue;
      const p = Math.round(sigmoid(logit(a.p) + family.b + dot(family.w, encode(a.features_used, family.features))) * 1000) / 1000;
      answers[q.id] = { ...a, p, risk: Math.round((q.risk === 'p' ? p : 1 - p) * 1000) / 1000,
        confidence: Math.round(Math.max(p, 1 - p) * 1000) / 1000, margin: Math.round(Math.abs(2 * p - 1) * 1000) / 1000 };
    }
    return { ...result, version: model.version, answers };
  };
}
