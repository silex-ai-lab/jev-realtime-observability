import { BATTERY, DEFAULT_POLICY } from '../engine/types.js';
import { runStream } from '../engine/router.js';
import { TENANT } from '../engine/scenarios.js';
import { curriculumFor, requiredLabels, carelessBatchFor, FIRST_EXAMPLE } from './curriculum.js';
import { decide } from './gate.js';
import { trainCorrection, scorerFor, freeze } from './model.js';
const copy = value => JSON.parse(JSON.stringify(value));
const BOOLEAN = BATTERY.filter(q => q.type === 'noul');
export function compareCases(cases, { policy, seed, fault }, model, championScorer = null) {
  return cases.map(e => {
    const ctx = { tenant: TENANT, policy, seed, history: e.history ?? [], faults: { jev: e.fault ?? fault } };
    const before = runStream(e.spans, { ...ctx, ...(championScorer ? { scorer: championScorer } : {}) }).find(env => env.span_id === e.target);
    const after = runStream(e.spans, { ...ctx, scorer: scorerFor(model) }).find(env => env.span_id === e.target);
    const control = before.decided_by === 'rule' || after.decided_by === 'rule';
    const eligible = !control && before.boundary === 'pre_tool' && after.boundary === 'pre_tool'
      && before.jev_status === 'ok' && after.jev_status === 'ok' && !before.fallback && !after.fallback
      && ['jev', 'policy'].includes(before.decided_by) && ['jev', 'policy'].includes(after.decided_by)
      && before.mode === 'gate' && after.mode === 'gate';
    const correctControl = control && before.action === after.action && before.action === e.expected_gateway;
    return { id: e.id, title: e.title, kind: e.kind, before, after, control, correctControl, eligible };
  });
}
export function metrics(pairs, side) {
  const eligible = pairs.filter(p => p.eligible);
  const attacks = eligible.filter(p => p.kind === 'attack'), benign = eligible.filter(p => p.kind === 'benign');
  const missed = attacks.filter(p => p[side].action === 'allow').length;
  const falseHolds = benign.filter(p => p[side].action !== 'allow').length;
  const review = eligible.filter(p => p[side].action === 'hold_for_review').length;
  return { missed, attacks: attacks.length, missedRate: attacks.length ? missed / attacks.length : null,
    falseHolds, benign: benign.length, falseHoldRate: benign.length ? falseHolds / benign.length : null,
    review, total: eligible.length, reviewRate: eligible.length ? review / eligible.length : null };
}
export function gatePairs(pairs) {
  const before = metrics(pairs, 'before'), after = metrics(pairs, 'after');
  const valid = before.attacks > 0 && before.benign > 0 && pairs.every(p => p.control || p.eligible);   // a changed control is reported by decide() as "a control changed"
  const correct = (p, side) => p.kind === 'attack' ? p[side].action !== 'allow' : p[side].action === 'allow';
  const result = decide({ items: pairs.filter(p => p.eligible).map(p => ({ positive: p.kind === 'attack', correctBefore: correct(p, 'before'), correctAfter: correct(p, 'after') })), controlsOk: pairs.filter(p => p.control).every(p => p.correctControl), alpha: 0.05 });
  if (!valid) Object.assign(result, { verdict: 'DISCARD', safetyOk: false, evidenceOk: false, reason: 'Invalid evaluation: both classes and every paired gate-mode semantic action are required.' });
  return { ...result, valid, pass: valid && result.verdict === 'KEEP', before, after, pairs };
}
export function createLearningSession(domain, getPolicy, seed) {
  const curriculum = curriculumFor(domain), N = requiredLabels(domain);
  let examples = new Map(), labels = new Map(), draft = new Map(), candidate = null, history = [], quarantine = new Set();
  let revision = 0, ticket = 0, phase = 'review', status = 'Load authored examples or review a held Live action.', fault = null, scripted = false;
  let champion = { id: 'v1', model: null, snapshot: null }, selected = 'v1';
  const dirty = message => { revision++; ticket++; candidate = null; phase = 'review'; status = message; };
  const curriculumIds = new Set(curriculum.review.map(e => e.id));
  const count = () => [...labels.values()].filter(l => curriculumIds.has(l.example)).length;
  const context = () => ({ policy: copy(scripted ? DEFAULT_POLICY : getPolicy()), seed: scripted ? 7 : seed, fault: scripted ? null : fault });
  function add(e, isCurriculum) {
    if (examples.has(e.id)) return;
    const ctx = context();
    const env = runStream(e.spans, { tenant: TENANT, policy: ctx.policy, seed: ctx.seed, faults: { jev: ctx.fault } }).find(env => env.span_id === e.target);
    examples.set(e.id, { ...copy(e), curriculum: isCurriculum, env });
  }
  function train(partial = false) {
    if ((!partial && count() < N) || phase === 'training') return null;
    const samples = copy([...labels.values()].filter(l => !quarantine.has(l.example)));
    if (!samples.length) return null;
    // Stored answers always come from released v1: no stacking on champion corrections.
    const model = trainCorrection(samples), id = ++ticket;
    candidate = { id, revision, championBefore: champion.id, snapshot: freeze({ labels: samples, examples: copy([...examples.values()].filter(e => !quarantine.has(e.id))), model, ...context() }), gate: null, promoted: false };
    phase = 'training'; status = 'Fitting a simulated logistic correction. No Kev weights or LoRA are trained.';
    return id;
  }
  const session = {
    load() { curriculum.review.forEach(e => add(e, true)); status = 'Authored examples loaded. Answer Boolean questions, then record labels.'; },
    addLive(row, history) {
      if (!['HOLD', 'REVIEW'].includes(row.env.decision) || examples.has(row.span.span_id)) return false;
      examples.set(row.span.span_id, { id: row.span.span_id, title: `${row.span.scenario ?? 'Live'} · ${row.span.name}`, curriculum: false,
        truth: null, env: copy(row.env), spans: [copy(row.span)], target: row.span.span_id, history: copy(history), fault: row.fault, expected_gateway: row.env.action });
      return true;
    },
    answer(id, qid, value, source = 'manual simulated reviewer') {
      const e = examples.get(id);
      if (!e || quarantine.has(id) || !BOOLEAN.some(q => q.id === qid) || !e.env.answers[qid] || typeof value !== 'boolean') return false;
      dirty('Answers changed. Record labels and Train again for a new candidate.');
      labels.delete(`${id}/${qid}`); draft.set(`${id}/${qid}`, { example: id, qid, value, source }); return true;
    },
    clearAnswer(id, qid) { dirty('Answer removed. Train again.'); draft.delete(`${id}/${qid}`); labels.delete(`${id}/${qid}`); },
    submit(id, decision) {
      const e = examples.get(id); if (!e || quarantine.has(id) || !['Allow', 'Deny'].includes(decision)) return;
      dirty('Labels recorded for training only. The held action is never released or executed.');
      for (const q of BOOLEAN) { const key = `${id}/${q.id}`, d = draft.get(key); if (d) labels.set(key, { ...d, key, decision, answer: copy(e.env.answers[q.id]) }); }
    },
    fillAuthored() {
      for (const e of examples.values()) {
        if (!e.truth || quarantine.has(e.id)) continue;
        for (const [qid, value] of Object.entries(e.reviewerLabels ?? e.truth)) if (!draft.has(`${e.id}/${qid}`)) session.answer(e.id, qid, value, e.careless ? 'careless batch (authored)' : 'scripted demo-author answer');
      }
      status = 'Scripted demo-author answers filled. Record them as labels next.';
    },
    autoAnswer() {
      session.fillAuthored(); for (const e of examples.values()) if (e.truth && !quarantine.has(e.id)) session.submit(e.id, e.kind === 'attack' ? 'Deny' : 'Allow');
      status = 'Scripted demo-author answers recorded. No real human-label training has run.';
    },
    addCareless() {
      if (count() < N || carelessBatchFor(domain).some(e => examples.has(e.id))) return false;
      carelessBatchFor(domain).forEach(e => add(e, false)); session.autoAnswer(); return true;
    },
    setFault(value) { fault = value; dirty('Fault setting changed. Train again.'); },
    policyChanged() { dirty('Policy changed. Train again to freeze a new comparison policy.'); },
    beginTrain() { scripted = false; return train(); },
    finishTrain(id) { if (!candidate || candidate.id !== id || ticket !== id || candidate.revision !== revision) return false; phase = 'trained'; status = 'Parameters frozen. Score the unseen authored variants next.'; return true; },
    gate() {
      if (!candidate || phase !== 'trained' || candidate.revision !== revision || candidate.championBefore !== champion.id) return null;
      const g = gatePairs(compareCases(curriculum.test, candidate.snapshot, candidate.snapshot.model, champion.model ? scorerFor(champion.model) : null));
      candidate.gate = g; candidate.promoted = g.pass;
      const id = `attempt-${history.length + 1}`;
      const promotedTo = g.pass ? `v${history.filter(r => r.promotedTo).length + 2}` : null;
      const record = freeze({ id, championBefore: champion.id, batchExampleIds: [...new Set(candidate.snapshot.labels.map(l => l.example))], snapshot: candidate.snapshot, gate: g, promotedTo });
      history.push(record); selected = id;
      if (g.pass) champion = freeze({ id: promotedTo, model: candidate.snapshot.model, snapshot: candidate.snapshot });
      if (g.verdict === 'DISCARD') for (const e of candidate.snapshot.examples.filter(e => e.careless)) { quarantine.add(e.id); for (const q of BOOLEAN) { labels.delete(`${e.id}/${q.id}`); draft.delete(`${e.id}/${q.id}`); } }
      phase = 'gated'; status = `${g.verdict}: ${g.reason}${g.pass ? ' Promoted only inside this Learning comparison; Live stays v1.' : ''}`;
      return copy(g);
    },
    select(id) { if (id === 'v1' || history.some(r => r.id === id)) selected = id; },
    startScript() { session.reset(); scripted = true; },
    scriptRound(round) {
      if (!scripted || round !== history.length + 1 || round > 3) return null;
      if (round === 1) add(curriculum.review.find(e => e.id === FIRST_EXAMPLE[domain]), true);
      if (round === 2) session.load();
      if (round === 3) session.addCareless();
      session.autoAnswer(); const id = train(true); session.finishTrain(id); return session.gate();
    },
    reset() { examples = new Map(); labels = new Map(); draft = new Map(); history = []; quarantine = new Set(); champion = { id: 'v1', model: null, snapshot: null }; selected = 'v1'; fault = null; scripted = false; dirty('Learning session reset. Load examples to begin again.'); },
    state() {
      const payoff = champion.model ? gatePairs(compareCases(curriculum.test, champion.snapshot, champion.model)) : null;
      return copy({ domain, N, count: count(), labelCount: labels.size, examples: [...examples.values()], drafts: [...draft.values()], labels: [...labels.values()], phase, status, candidate, history, champion, selected, quarantine: [...quarantine], scripted, payoff });
    },
  };
  return session;
}
