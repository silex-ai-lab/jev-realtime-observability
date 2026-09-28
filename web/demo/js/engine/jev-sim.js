// Simulated judgment battery (T1). One call, many atomic answers.
//
// Probabilities are a documented deterministic function of `features_used`
// (the battery question's `features` list) plus seeded jitter ≤ ±0.04, rounded
// to 3 dp. No span id, name or label is read here (CONTRACT §3).

import { JEV_SIM_VERSION, LATENCY_BUDGET, PRICES } from './types.js';
import { rngFor } from './rng.js';

const JITTER = 0.04;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round3 = x => Math.round(x * 1000) / 1000;
const draw = (seed, spanId, purpose, [lo, hi]) =>
  Math.round(rngFor(seed, spanId, purpose).uniform(lo, hi));

// --- Documented feature → probability functions. ----------------------------

// exfil (noul, risk = p): P(the call sends sensitive data to an unauthorised target).
//   p = 0.10 + 0.35·[any sensitive field in args] + 0.45·[domain not allowlisted]
//             + 0.15·untrusted_text_share   (capped at 0.95)
function exfilP(f) {
  const sensitive = (f.sensitive_fields_in_args ?? 0) > 0 ? 0.35 : 0;
  const disallowed = f.domain_allowed === false ? 0.45 : 0;
  const untrusted = (f.untrusted_text_share ?? 0) * 0.15;
  return clamp(0.10 + sensitive + disallowed + untrusted, 0, 0.95);
}

// payee_mismatch (noul, risk = p): P(the invoice payee differs from the account
// holder). Driven by name similarity (token Jaccard; 1.0 = identical).
//   p = 0.15 if payee_similarity is null, else clamp(0.88 − 0.82·similarity, 0.02, 0.97)
function payeeMismatchP(f) {
  const s = f.payee_similarity;
  if (s == null) return 0.15;
  return clamp(0.88 - 0.82 * s, 0.02, 0.97);
}

// grounded (noul, risk = 1 − p): P(the draft is supported only by the evidence).
//   p = clamp(0.98 − 0.07·unsupported_claims, 0.02, 0.98)
function groundedP(f) {
  return clamp(0.98 - 0.07 * (f.unsupported_claims ?? 0), 0.02, 0.98);
}

// intervene (noul, risk = p): P(this trajectory needs intervention now).
//   p = 0.12 + 0.18·repeat_failures + 0.55·[last tool status non-2xx]   (capped at 0.97)
function interveneP(f) {
  return clamp(0.12 + 0.18 * (f.repeat_failures ?? 0) + (f.tool_status_error ? 0.55 : 0), 0, 0.97);
}

// impact (score 0..3): distribution peaked at severity s.
//   s = tool_impact (read 0 · write 1 · payment 2); +1 if payment over limit
//   logit[level] ∝ −0.8·|level − s|
function impactSeverity(f) {
  let s = f.tool_impact ?? 0;
  if (s === 2 && f.amount_ratio != null && f.amount_ratio >= 1) s = 3;
  return s;
}

// attack (choice over safe / prompt_injection / privilege_abuse / exfiltration):
// logits. A retrieved note with markers but no concrete disallowed destination
// is not yet an attack (R p.8: the input boundary alone looked benign); a
// non-allowlisted destination is decisive.
//   disallowed = domain_allowed === false
//   acted      = disallowed || untrusted_text_share > 0.3
//   logit.safe              = 0.3
//   logit.prompt_injection  = −4 + 4.5·injection_marker_score·(disallowed ? 1.0 : 0.4)·acted
//   logit.exfiltration       = −4 + 4.0·disallowed
//   logit.privilege_abuse    = −4
function attackLogits(f) {
  const disallowed = f.domain_allowed === false ? 1 : 0;
  const inj = f.injection_marker_score ?? 0;
  const ut = f.untrusted_text_share ?? 0;
  const acted = (disallowed || ut > 0.3) ? 1 : 0;
  return {
    safe: 0.3,
    prompt_injection: -4 + 4.5 * inj * (disallowed ? 1.0 : 0.4) * acted,
    exfiltration: -4 + 4.0 * disallowed,
    privilege_abuse: -4,
  };
}

const NOUL_P = { exfil: exfilP, payee_mismatch: payeeMismatchP, grounded: groundedP, intervene: interveneP };

function featuresUsed(q, safeView) {
  const out = {};
  for (const name of q.features) out[name] = safeView.features[name];
  return out;
}

function softmaxDist(keys, logits, rng) {
  const jittered = {};
  for (const k of keys) jittered[k] = logits[k] + (rng.next() * 2 - 1) * JITTER;
  const maxL = Math.max(...keys.map(k => jittered[k]));
  let sum = 0;
  const exps = {};
  for (const k of keys) { exps[k] = Math.exp(jittered[k] - maxL); sum += exps[k]; }
  const dist = {};
  for (const k of keys) dist[k] = round3(exps[k] / sum);
  return dist;
}

function noulAnswer(q, safeView, seed, spanId) {
  const f = featuresUsed(q, safeView);
  const base = NOUL_P[q.id](f);
  const rng = rngFor(seed, spanId, `jev:${q.id}`);
  const p = round3(clamp(base + (rng.next() * 2 - 1) * JITTER, 0, 1));
  const risk = round3(q.risk === 'p' ? p : 1 - p);
  return {
    type: 'noul',
    p,
    risk,
    confidence: round3(Math.max(p, 1 - p)),
    margin: round3(Math.abs(2 * p - 1)),
    features_used: f,
  };
}

function distAnswer(q, safeView, seed, spanId) {
  const f = featuresUsed(q, safeView);
  const rng = rngFor(seed, spanId, `jev:${q.id}`);
  let logits;
  if (q.id === 'attack') {
    logits = attackLogits(f);
  } else if (q.type === 'score') {
    const s = impactSeverity(f);
    logits = {};
    for (const lvl of q.options) logits[lvl] = -0.8 * Math.abs(Number(lvl) - s);
  }
  const dist = softmaxDist(q.options, logits, rng);
  const sorted = [...q.options].sort((a, b) => dist[b] - dist[a]);
  const top = sorted[0];
  const ans = {
    type: q.type,
    dist,
    top,
    confidence: round3(dist[top]),
    margin: round3(dist[sorted[0]] - dist[sorted[1]]),
    features_used: f,
  };
  if (q.type === 'score') {
    ans.expected = round3(q.options.reduce((acc, l) => acc + Number(l) * dist[l], 0));
  }
  return ans;
}

function answerFor(q, safeView, seed, spanId) {
  return q.type === 'noul' ? noulAnswer(q, safeView, seed, spanId) : distAnswer(q, safeView, seed, spanId);
}

export function judgeBattery(safeView, questions, { seed, spanId, deadline_ms, fault }) {
  const reduced = fault === 'rtt_spike';
  let status = 'ok';
  let latency_ms;
  let serialize_ms;

  if (fault === 'timeout') {
    status = 'timeout';
    latency_ms = deadline_ms;
    serialize_ms = draw(seed, spanId, 'serialize', LATENCY_BUDGET.serialize);
  } else if (fault === 'down') {
    status = 'down';
    latency_ms = 0;
    serialize_ms = 0;
  } else {
    serialize_ms = draw(seed, spanId, 'serialize', LATENCY_BUDGET.serialize);
    latency_ms = draw(seed, spanId, 'jev', reduced ? LATENCY_BUDGET.rttSpikeJev : LATENCY_BUDGET.jev);
    if (latency_ms > deadline_ms) { status = 'timeout'; latency_ms = deadline_ms; }
  }

  let answers = {};
  let tokens_in = 0;
  let cost_usd = 0;
  if (status === 'ok') {
    for (const q of questions) answers[q.id] = answerFor(q, safeView, seed, spanId);
    tokens_in = Math.ceil(JSON.stringify(safeView).length / 4) + 24 * questions.length;
    cost_usd = (tokens_in * PRICES.jevInputUsdPerMTok) / 1e6;
  }

  return { status, version: JEV_SIM_VERSION, latency_ms, serialize_ms, answers, tokens_in, cost_usd, reduced };
}
