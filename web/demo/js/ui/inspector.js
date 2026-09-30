// Decision Inspector: one routed span, its decision order, the simulated Jev
// answers with threshold bands, the three-path comparison, envelope and SIEM line.

import { BATTERY, LATENCY_BUDGET, PRICES } from '../engine/types.js';
import { buildState } from '../engine/state.js';
import { combine } from '../engine/policy.js';
import { judgeSlow } from '../engine/llm-sim.js';
import { toSiemLine } from '../engine/siem.js';
import { esc, chip, decisionChip, fmtMs, fmtP, fmtUsd, ACTION_TEXT } from './util.js';

const Q = Object.fromEntries(BATTERY.map(q => [q.id, q]));
const RULE_TEXT = {
  amount_limit: 'Amount above the approval limit',
  approval_evidence: 'No approved approval evidence',
  domain_allowlist: 'Destination not on the allowlist',
  readback_mismatch: 'Tool said OK, ERP read-back disagrees',
  stale_state: 'State snapshot is stale',
  repeat_failure: 'Same failure repeated',
  privileged_suspend_incident: 'Suspending a privileged account without an approved incident',
  allowlist_change_approval: 'Allowlisting an IP without an approved change',
};

function band(ans, th) {
  const r = th?.review_threshold ?? 1, b = th?.block_threshold ?? 1;
  const x = Math.min(1, Math.max(0, ans.risk ?? ans.p ?? 0));
  return `<div class="band" role="img" aria-label="risk ${fmtP(x)}; review from ${r}, block from ${b}">
      <span class="a" style="width:${r * 100}%"></span><span class="r" style="width:${(b - r) * 100}%"></span><span class="x" style="width:${(1 - b) * 100}%"></span>
      <i class="mk" style="left:calc(${x * 100}% - 1px)"></i></div>
    <div class="band-l"><span>0 · allow</span><span>review ≥ ${r}</span><span>block ≥ ${b}</span><span>1</span></div>`;
}

function dist(ans, q) {
  const opts = Object.keys(ans.dist ?? {});
  const label = o => (q?.optionLabels ? `${o} ${q.optionLabels[Number(o)] ?? ''}` : o);
  return `<div class="dist">${opts.map(o => {
    const p = ans.dist[o];
    return `<span class="${o === ans.top ? 'top' : ''}">${esc(label(o))}</span><span class="bar"><i style="width:${p * 100}%"></i></span><span class="mono">${fmtP(p)}</span>`;
  }).join('')}</div>`;
}

function features(f) {
  const e = Object.entries(f ?? {});
  return e.length ? `<div class="feat">features used: ${e.map(([k, v]) => `${esc(k)}=${v == null ? 'n/a' : esc(typeof v === 'number' ? +v.toFixed(3) : v)}`).join(' · ')}</div>` : '';
}

function answerCard(qid, ans, policy, advisory) {
  const q = Q[qid];
  const head = `<div class="ans-h"><b>${esc(qid)}</b>${chip(ans.type, 'b')}${chip('simulated', 'sim')}
    <span class="jv-meta">confidence ${fmtP(ans.confidence)} · margin ${fmtP(ans.margin)}</span></div>`;
  let body;
  if (ans.type === 'noul') {
    const dir = q?.risk === '1-p' ? `risk = 1 − p (p = ${fmtP(ans.p)})` : `risk = p = ${fmtP(ans.p)}`;
    body = `<div class="jv-meta" style="font-size:12px;margin-bottom:4px">${esc(dir)}</div>${band(ans, policy?.thresholds?.[qid])}`;
  } else {
    body = dist(ans, q) + (ans.type === 'score' && ans.expected != null ? `<div class="jv-meta" style="font-size:11px">expected level ${fmtP(ans.expected)}</div>` : '');
  }
  return `<div class="ans ${advisory ? 'adv' : ''}" data-jev-answer="${esc(qid)}" data-simulated="true">${head}
    <div class="ans-q">${esc(q?.text ?? '')}</div>${body}${features(ans.features_used)}</div>`;
}

function step(cls, title, ms, detail) {
  return `<li class="${cls}"><div class="ph"><b>${title}</b><span class="ms">${ms}</span></div>${detail ? `<div class="pd">${detail}</div>` : ''}</li>`;
}

/** row: { span, env }; ctx: { tenant, seed, policyFor(version), history(row) } */
export function renderInspector(el, row, ctx) {
  if (!row) { el.innerHTML = '<p class="jv-empty">Select a span, or press Play.</p>'; el.dataset.spanId = ''; return; }
  const { span, env } = row;
  const policy = ctx.policyFor(env.policy_version);
  const lb = env.latency_breakdown ?? {};
  const byRule = env.decided_by === 'rule';
  const answers = Object.entries(env.answers ?? {});
  const jevOk = env.jev_status === 'ok';
  el.dataset.spanId = env.span_id;

  // Three-path comparison, computed from the same state (report p.15 "wow moment").
  const state = buildState(span, ctx.history(row), ctx.tenant, span.t_ms ?? 0);
  let jevAlone = null;
  try {
    jevAlone = combine(state, { hits: [], verdict: null, latency_ms: 0 }, { status: env.jev_status, answers: env.answers ?? {} }, policy, { tenant: ctx.tenant });
  } catch { /* engine not ready */ }
  const slow = env.escalation ?? judgeSlow(state.safeView, { seed: ctx.seed, spanId: env.span_id, reason: 'comparison' });

  const ruleHits = env.rule_hits ?? [];
  const ruleVerdict = ruleHits.length ? ruleHits.map(h => h.verdict).join(', ') : 'pass';

  const notes = [];
  if (byRule && answers.length) {
    notes.push(`<div class="note warn" data-override-note>Hard rule decided. Jev ran off the critical path for display only;
      no probability or threshold can override ${esc(ruleHits.map(h => h.id).join(', '))}.${
      env.decision === 'HOLD' ? ' A confident “safe” answer cannot supply missing authorisation.' : ''}</div>`);
  }
  if (env.jev_status && env.jev_status !== 'ok' && env.jev_status !== 'skipped') {
    notes.push(`<div class="note bad">Judge ${esc(env.jev_status)} at the ${fmtMs(policy?.deadline_ms)} deadline: <b>no answer is not “safe”</b>.
      ${env.fallback?.reason ? esc(String(env.fallback.reason).replace(/\.?$/, '.')) : ''} No earlier verdict is reused.</div>`);
  }
  if (env.mode === 'monitor') {
    notes.push(`<div class="note info">Monitor (shadow) mode: the gateway received <b>${esc(ACTION_TEXT[env.action] ?? env.action)}</b>;
      the policy would have returned <b>${esc(env.would_have)}</b>.</div>`);
  }

  const pipe = [];
  pipe.push(step('on', '1 · State Engine', '', `schema ${esc(state.schema_version)} · snapshot age ${fmtMs(state.age_ms)} · evidence ${esc((env.evidence_refs ?? []).join(', ') || '—')}`));
  pipe.push(step(ruleHits.length ? 'hit' : 'on', '2 · Hard rules (code, veto)', fmtMs(lb.rules),
    ruleHits.length ? ruleHits.map(h => `${chip(h.verdict, h.verdict)} <b>${esc(h.id)}</b>: ${esc(h.reason ?? RULE_TEXT[h.id] ?? '')}`).join('<br>') : 'No rule hit.'));
  pipe.push(step(env.jev_on_critical_path ? 'on' : 'off', `3 · Jev battery (simulated)${env.jev_on_critical_path ? '' : ' · advisory, off the critical path'}`,
    env.jev_on_critical_path ? `${fmtMs(lb.serialize)} + ${fmtMs(lb.jev)}` : 'not counted',
    `${esc(env.judge)} · status ${esc(env.jev_status ?? '—')} · ${answers.length} atomic answers in one call · deadline ${fmtMs(policy?.deadline_ms)} · fallback ${esc(env.fallback_level)}`));
  pipe.push(step('on', '4 · Policy (code)', fmtMs(lb.policy),
    `${esc(env.policy_version)} · ${(env.reasons ?? []).map(esc).join('; ') || 'no threshold crossed'}`));
  if (env.escalation) {
    pipe.push(step('off', '5 · Slow path for rationale (async)', `${fmtMs(env.escalation.latency_ms)} · not in gate latency`,
      `${esc(env.escalation.judge)} · ${esc(env.escalation.reason ?? '')} · ${esc(env.escalation.rationale ?? '')}`));
  }
  pipe.push(step('on', `${env.escalation ? 6 : 5} · Action → customer gateway (simulated)`, '',
    `${esc(ACTION_TEXT[env.action] ?? env.action)} · mode ${esc(env.mode)} · execution stays with the customer's IAM / gateway`));
  if (env.boundary === 'post_tool') {
    pipe.push(step(ruleHits.some(h => h.id === 'readback_mismatch') ? 'hit' : 'on', 'Read-back rule (post_tool span)', '',
      span.readback ? `tool result ${esc(span.result?.status)} · ERP read-back posted = ${esc(span.readback.posted)}` : 'No read-back on this span.'));
  }

  // The one-line "why": the deciding rule's reason, else the policy's reasons, else what was checked.
  const why = ruleHits.length ? ruleHits.map(h => h.reason ?? RULE_TEXT[h.id] ?? h.id)
    : (env.reasons ?? []).length ? env.reasons : [env.decision === 'ALLOW' ? 'No hard rule hit and no threshold crossed.' : `Decided by ${env.decided_by}.`];
  el.innerHTML = `
    <div class="jv-insp-head">
      <p class="jv-title">${esc(span.name)} ${span.scenario ? chip(span.scenario, 'sc') : ''}</p>
      <div class="jv-meta">${esc(ctx.traceTitle(span))} · ${chip(env.boundary, 'b')}</div>
    </div>
    <div class="jv-verdict">
      <span class="big ${esc(env.decision)}" data-decision="${esc(env.decision)}">${esc(env.decision)}</span>
      <div><div>decided by <b>${esc(env.decided_by)}</b>${env.alert ? ' · <b>alert</b>' : ''}</div>
      <div class="jv-meta">simulated added gate latency <b>${fmtMs(env.decision_latency_ms)}</b> · risk ${esc(env.risk?.label ?? '—')}</div></div>
    </div>
    <ul class="jv-why" data-why>${why.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
    ${notes.join('')}
    <details class="jv-tech"><summary>Technical details <span class="jv-meta">decision order · Jev answers · three paths · envelope</span></summary>
    <div class="jv-meta" style="margin:6px 0 2px">${esc(env.trace_id)} / ${esc(env.span_id)}</div>
    <ol class="pipe">${pipe.join('')}</ol>

    <h3>Jev answers ${jevOk ? '' : '· none'}</h3>
    ${jevOk ? answers.map(([qid, a]) => answerCard(qid, a, policy, byRule)).join('') : `<p class="jv-meta">No answers: judge ${esc(env.jev_status ?? 'not called')}.</p>`}

    <h3>Three paths on this span</h3>
    <div class="tbl-wrap"><table class="tbl">
      <tr><th>Path</th><th>Verdict</th><th>Latency</th><th>Tokens</th><th>Cost</th></tr>
      <tr><td>Hard rules (code)</td><td>${esc(ruleVerdict)}</td><td class="num">${fmtMs(lb.rules)}</td><td class="num">0</td><td class="num">$0</td></tr>
      <tr><td>Jev battery alone (simulated)</td><td>${jevOk && jevAlone ? decisionChip(jevAlone.decision) : `no answer (${esc(env.jev_status ?? 'not called')})`}</td>
        <td class="num">${jevOk ? fmtMs((env.latency_breakdown?.serialize || 0) + (env.latency_breakdown?.jev || 0)) || '—' : fmtMs(policy?.deadline_ms)}</td>
        <td class="num">${env.tokens_in || 0}</td><td class="num" title="${esc(PRICES.source)}">${fmtUsd(env.cost_usd)}</td></tr>
      <tr><td>LLM judge (simulated${env.escalation ? ', escalated' : ', comparison only'})</td><td>${esc(slow?.verdict ?? '—')}</td>
        <td class="num">${fmtMs(slow?.latency_ms)}</td><td class="num">${esc((slow?.tokens_in ?? 0) + (slow?.tokens_out ?? 0))}</td><td class="num" title="No LLM price is sourced in the report">n/a</td></tr>
    </table></div>
    <p class="jv-meta" style="font-size:11px">Latencies simulated from the report's budget (Jev ${LATENCY_BUDGET.jev.join('–')} ms; LLM ${LATENCY_BUDGET.llm.map(v => (v / 1000).toFixed(2)).join('–')} s). ${
      env.jev_on_critical_path ? '' : 'Off the critical path here, so the Jev time was not added to the gate.'}</p>

    <details><summary>Verdict envelope (JSON)</summary><pre class="json" data-envelope>${esc(JSON.stringify(env, null, 2))}</pre></details>
    <details><summary>SIEM line (JSONL)</summary><pre class="json" data-siem>${esc(toSiemLine(env))}</pre></details>
    </details>`;
}
