// Runs adapter (logs/2026-09-30_CONSOLE_UX_PLAN.md r7 C1'): turns the demo's simulated
// spans and verdict envelopes (web/demo/js/engine/router.js) into the live record shapes the
// shared Runs view renders. Pure: no DOM, no fetch, no randomness — the same spans + envelopes
// always yield the same records. toRunRecords also registers each run's detail (sources,
// operation.args, text) so toRunDetail(runId) can answer the GET /v1/runs/:id fetch the shared
// renderer makes for those fields.
//
// Boundary → step (C1' "Steps by boundary"):
//   pre_tool        → tool call  (plus a synthetic post_tool receipt for its receipt/control)
//   pre_input       → source read (sources[].trust in {retrieved, tool} → instruction_authority 'none')
//   post_generation → statement (detail carries the text)
//   post_tool       → a finding after the fact (evidence, never a receipt)
// The run itself is synthesised from the demo trace: run_started carries the trace title as the
// task goal and the scenario id in attributes.scenario; run_finished closes the card.

// C1' "Pre_tool action → receipt and control". Every action router.js can emit is here.
// review_ticket on a pre_tool is defensive (not produced today): it stays a flag on an executed call.
const ACTION_RECEIPT = {
  allow:             { receipt: 'executed',     control: 'allow' },
  allow_and_alert:   { receipt: 'executed',     control: 'allow' }, // the flag is ALERT, never a deny control
  hold_for_review:   { receipt: 'not_executed', control: 'hold_for_review' },
  hold_for_approval: { receipt: 'not_executed', control: 'hold_for_approval' },
  deny:              { receipt: 'not_executed', control: 'deny' },
  stop_and_handover: { receipt: 'not_executed', control: 'deny' },  // STOP maps to a deny control
  review_ticket:     { receipt: 'executed',     control: null },    // defensive: flagged, executed, no gate
};

const detailStore = new Map(); // run_id → { run_id, timeline }

const isoAt = ms => new Date(Number.isFinite(ms) ? ms : 0).toISOString();
const baseTrace = id => String(id).split('~')[0];

// C1' decision mapping: ALLOW → NO_CONFIGURED_RISK; an allow that carries an alert is ALERT;
// ALERT, REVIEW, HOLD, BLOCK and STOP keep their names.
function recommendedFor(env) {
  if (env.decision === 'ALLOW') return env.alert ? 'ALERT' : 'NO_CONFIGURED_RISK';
  return env.decision;
}

// sources[].trust in {retrieved, tool} (or anything that is not user/system) has no authority.
function instructionAuthority(trust) {
  return trust === 'user' || trust === 'system' ? trust : 'none';
}

function actionMapping(env) {
  return ACTION_RECEIPT[env.action] ?? { receipt: env.action, control: null };
}

export function toRunRecords(spans, envelopes, opts = {}) {
  const titles = opts?.titles ?? null;
  const titleFor = id => {
    if (titles == null) return null;
    if (titles instanceof Map) return titles.get(id) ?? titles.get(baseTrace(id)) ?? null;
    return titles[id] ?? titles[baseTrace(id)] ?? null;
  };

  const envByEvent = new Map();
  for (const e of envelopes ?? []) if (e) envByEvent.set(e.event_id ?? e.span_id, e);

  const byTrace = new Map();
  for (const s of spans ?? []) if (s?.trace_id) {
    if (!byTrace.has(s.trace_id)) byTrace.set(s.trace_id, []);
    byTrace.get(s.trace_id).push(s);
  }

  const records = [];

  for (const [traceId, traceSpans] of byTrace) {
    const runId = traceId;
    const scenario = traceSpans.find(s => s.scenario)?.scenario ?? null;
    const rootSpan = traceSpans.find(s => s.boundary == null) ?? traceSpans[0];
    const taskGoal = titleFor(runId) ?? rootSpan?.text ?? scenario ?? runId;
    const timeline = [];
    let seq = 1;

    const put = (event) => { records.push({ kind: 'event', payload: event }); timeline.push({ event, evaluations: [], decisions: [] }); seq += 1; };

    const decisionRecord = (env, eventId) => ({
      kind: 'decision',
      payload: {
        decision_id: `dec-${env.event_id ?? env.span_id}`,
        event_id: eventId,
        recommended: recommendedFor(env),
        decided_by: env.decided_by ?? 'policy',
        reasons: (env.reasons ?? []).slice(),
        rule_results: (env.rule_hits ?? []).map(h => ({ rule_id: h.id, verdict: h.verdict, reason: h.reason, evidence_refs: h.evidence_refs ?? [], authoritative_source: 'demo' })),
        provenance: {
          source_mode: 'demo',
          judge_source: null,
          tool_environment: 'simulated',
          enforcement_mode: env.mode === 'monitor' ? 'shadow' : 'gate',
        },
        replay_of: null,
      },
    });

    // run_started (synthesised): the trace title is the task goal; the scenario id rides along.
    put({
      run_id: runId,
      event_id: `${runId}-started`,
      boundary: 'run_started',
      producer_seq: seq,
      received_at: isoAt(rootSpan?.t_ms ?? 0),
      occurred_at: isoAt(rootSpan?.t_ms ?? 0),
      task_goal: taskGoal,
      attributes: { scenario: scenario ?? '' },
    });

    for (const span of traceSpans) {
      const env = envByEvent.get(span.span_id);
      const t = span.t_ms ?? 0;
      const tool = span.tool?.name ?? env?.tool?.name ?? null;

      if (span.boundary === 'pre_tool') {
        const opId = `op-${span.span_id}`;
        const m = env ? actionMapping(env) : { receipt: null, control: null };
        put({
          run_id: runId, event_id: span.span_id, boundary: 'pre_tool',
          producer_seq: seq, received_at: isoAt(t), occurred_at: isoAt(t),
          tool, operation_id: opId,
          operation: { tool, operation_id: opId, args: span.tool?.args ?? {} },
          attributes: {},
        });
        // The synthetic receipt pairs with the call through operation_id (C1': operation_id pairing).
        if (m.control != null || m.receipt != null) {
          put({
            run_id: runId, event_id: `${span.span_id}-receipt`, boundary: 'post_tool',
            producer_seq: seq, received_at: isoAt(t + 1), occurred_at: isoAt(t + 1),
            tool, operation_id: opId,
            attributes: { receipt_status: m.receipt, ...(m.control != null ? { control_action: m.control } : {}) },
          });
        }
        if (env) records.push(decisionRecord(env, span.span_id));
      } else if (span.boundary === 'pre_input') {
        put({
          run_id: runId, event_id: span.span_id, boundary: 'pre_input',
          producer_seq: seq, received_at: isoAt(t), occurred_at: isoAt(t),
          attributes: {},
          sources: (span.sources ?? []).map(s => ({ id: s.id, producer: 'demo', authenticity: 'unverified', instruction_authority: instructionAuthority(s.trust), excerpt: s.text ?? '' })),
        });
        if (env) records.push(decisionRecord(env, span.span_id));
      } else if (span.boundary === 'post_generation') {
        put({
          run_id: runId, event_id: span.span_id, boundary: 'post_generation',
          producer_seq: seq, received_at: isoAt(t), occurred_at: isoAt(t),
          text: span.text ?? null, attributes: {},
        });
        if (env) records.push(decisionRecord(env, span.span_id));
      } else if (span.boundary === 'post_tool') {
        // A finding after the fact: its evidence, never a receipt (it never makes an earlier call "did not run").
        const evidence = [];
        if (span.result?.status != null) evidence.push(`tool result ${span.result.status}`);
        if (span.readback != null) evidence.push(`read-back posted = ${span.readback.posted}`);
        put({
          run_id: runId, event_id: span.span_id, boundary: 'post_tool',
          producer_seq: seq, received_at: isoAt(t), occurred_at: isoAt(t),
          tool, attributes: { evidence: evidence.join(' · ') },
        });
        if (env) records.push(decisionRecord(env, span.span_id));
      }
    }

    put({
      run_id: runId, event_id: `${runId}-finished`, boundary: 'run_finished',
      producer_seq: seq, received_at: isoAt((traceSpans.at(-1)?.t_ms ?? 0) + 2), occurred_at: isoAt((traceSpans.at(-1)?.t_ms ?? 0) + 2),
      attributes: {},
    });

    detailStore.set(runId, { run_id: runId, timeline });
  }

  return records;
}

export function toRunDetail(runId) {
  return detailStore.get(runId) ?? null;
}
