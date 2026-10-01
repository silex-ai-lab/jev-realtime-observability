import { BATTERY } from '../engine/types.js';
import { runStream } from '../engine/router.js';
import { TENANT } from '../engine/scenarios.js';
import { curriculumFor, requiredLabels, FAILED_FAMILY } from './curriculum.js';
import { trainCorrection, scorerFor, freeze } from './model.js';
const copy = value => JSON.parse(JSON.stringify(value));
const BOOLEAN = BATTERY.filter(q => q.type === 'noul');
export function compareCases(cases, { policy, seed, fault }, model) {
  return cases.map(e => {
    const ctx = { tenant: TENANT, policy, seed, history: e.history ?? [], faults: { jev: e.fault ?? fault } };
    const before = runStream(e.spans, ctx).find(env => env.span_id === e.target);
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
  const falseHolds = benign.filter(p => ['hold_for_review', 'hold_for_approval', 'deny', 'stop_and_handover'].includes(p[side].action)).length;
  const review = eligible.filter(p => p[side].action === 'hold_for_review').length;
  return { missed, attacks: attacks.length, missedRate: attacks.length ? missed / attacks.length : null,
    falseHolds, benign: benign.length, falseHoldRate: benign.length ? falseHolds / benign.length : null,
    review, total: eligible.length, reviewRate: eligible.length ? review / eligible.length : null };
}
export function gatePairs(pairs) {
  const before = metrics(pairs, 'before'), after = metrics(pairs, 'after');
  const valid = before.attacks > 0 && before.benign > 0 && pairs.every(p => p.control ? p.correctControl : p.eligible);
  const pass = valid && after.missedRate <= before.missedRate && after.falseHoldRate <= before.falseHoldRate
    && (after.missedRate < before.missedRate || after.falseHoldRate < before.falseHoldRate);
  return { valid, pass, before, after, pairs, reason: !valid ? 'Inconclusive: both classes and gate-mode successful semantic variants are required; controls must remain correct.'
    : pass ? 'Pass: neither missed attacks nor false holds increased, and at least one decreased.' : 'Rejected: no strict improvement or a regression. Promotion stays disabled.' };
}
export function createLearningSession(domain, getPolicy, seed) {
  const curriculum = curriculumFor(domain), N = requiredLabels(domain);
  let examples = new Map(), labels = new Map(), draft = new Map(), candidate = null;
  let revision = 0, ticket = 0, phase = 'review', status = 'Load authored examples or review a held Live action.', failed = false, fault = null;
  const dirty = message => { revision++; ticket++; candidate = null; phase = 'review'; status = message; };
  const curriculumIds = new Set(curriculum.review.map(e => e.id));
  const count = () => [...labels.values()].filter(l => curriculumIds.has(l.example)).length;
  function add(e, isCurriculum) {
    if (examples.has(e.id)) return;
    const env = runStream(e.spans, { tenant: TENANT, policy: getPolicy(), seed, faults: { jev: fault } }).find(env => env.span_id === e.target);
    examples.set(e.id, { ...copy(e), curriculum: isCurriculum, env });
  }
  function invalidate(message) { dirty(message); }
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
      if (!e || !BOOLEAN.some(q => q.id === qid) || !e.env.answers[qid] || typeof value !== 'boolean') return false;
      dirty('Answers changed. Record labels and Train again for a new candidate.');
      labels.delete(`${id}/${qid}`);
      draft.set(`${id}/${qid}`, { example: id, qid, value, source });
      return true;
    },
    clearAnswer(id, qid) { dirty('Answer removed. Train again.'); draft.delete(`${id}/${qid}`); labels.delete(`${id}/${qid}`); },
    submit(id, decision) {
      const e = examples.get(id); if (!e || !['Allow', 'Deny'].includes(decision)) return;
      dirty('Labels recorded for training only. The held action is never released or executed.');
      for (const q of BOOLEAN) { const key = `${id}/${q.id}`, d = draft.get(key); if (d) labels.set(key, { ...d, key, decision, answer: copy(e.env.answers[q.id]) }); }
    },
    fillAuthored() {
      for (const e of examples.values()) {
        if (!e.truth) continue;
        for (const [qid, value] of Object.entries(e.truth)) if (!draft.has(`${e.id}/${qid}`)) session.answer(e.id, qid, value, 'scripted demo-author answer');
      }
      status = 'Scripted demo-author answers filled. Record them as labels next.';
    },
    autoAnswer() {
      session.fillAuthored();
      for (const e of examples.values()) if (e.truth) session.submit(e.id, e.kind === 'attack' ? 'Deny' : 'Allow');
      status = 'Scripted demo-author answers recorded. No real human-label training has run.';
    },
    failed(on) { if (failed !== on) { failed = on; dirty('Candidate invalidated. Train again with the selected batch setting.'); } },
    setFault(value) { fault = value; invalidate('Fault setting changed. Train again.'); },
    policyChanged() { invalidate('Policy changed. Train again to freeze a new comparison policy.'); },
    beginTrain() {
      if (count() < N) return null;
      const samples = copy([...labels.values()]);
      const model = trainCorrection(samples, failed ? FAILED_FAMILY[domain] : null);
      const id = ++ticket;
      candidate = { id, revision, snapshot: freeze({ labels: samples, examples: copy([...examples.values()]), model, policy: copy(getPolicy()), seed, fault, failed }), gate: null, promoted: false };
      phase = 'training'; status = 'Fitting a simulated logistic correction. No Kev weights or LoRA are trained.';
      return id;
    },
    finishTrain(id) { if (!candidate || candidate.id !== id || ticket !== id) return false; phase = 'trained'; status = 'Parameters frozen. Score the unseen authored variants next.'; return true; },
    gate() {
      if (!candidate || phase === 'training') return null;
      candidate.gate = gatePairs(compareCases(curriculum.test, candidate.snapshot, candidate.snapshot.model));
      candidate.promoted = false; phase = 'gated'; status = candidate.gate.reason;
      return copy(candidate.gate);
    },
    promote() {
      if (!candidate || candidate.revision !== revision || !candidate.gate?.pass || phase !== 'gated') return false;
      candidate.sessionPairs = compareCases(candidate.snapshot.examples, candidate.snapshot, candidate.snapshot.model);
      candidate.promoted = true; phase = 'promoted'; status = 'v2 selected only for this Learning comparison. Live and production are unchanged.'; return true;
    },
    reset() { examples = new Map(); labels = new Map(); draft = new Map(); failed = false; dirty('Learning session reset. Load examples to begin again.'); },
    state() {
      return copy({ domain, N, count: count(), labelCount: labels.size, examples: [...examples.values()], drafts: [...draft.values()], labels: [...labels.values()],
        phase, status, failed, failedFamily: FAILED_FAMILY[domain], candidate });
    },
  };
  return session;
}
