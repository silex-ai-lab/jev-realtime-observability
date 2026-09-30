// Live console. Renders only server records (events, evaluations, decisions) from the persisted
// SSE outbox; it computes no verdicts. Keys live in this module's memory only.
const $ = (s, r = document) => r.querySelector(s);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ESC[c]);
const ms = v => (v == null ? '—' : `${Math.round(v)} ms`);
const p3 = v => (v == null ? '—' : Number(v).toFixed(3));
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
const nearestRank = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.max(0, Math.ceil(q * s.length) - 1)]; };

const keys = { reader: null, admin: null };
let authMode = 'keys';
let connected = false;
const rows = new Map();        // event_id → { event, evaluations: [], decisions: [], outcomes: [], el }
const MAX_ROWS = 500;          // DOM cap: the oldest rows are evicted, the selected row is kept
const evicted = new Set();     // event_ids of evicted rows: their late evaluations and decisions go straight to `archive`
let serverMetrics = null;
let cursor = '0', es = null, selected = null, lastAt = null, judgeInfo = null, activePolicy = null;
const counts = { expired: 0, gaps: 0 };

async function api(path, { method = 'GET', body, role = 'reader' } = {}) {
  const key = keys[role] ?? keys.reader;
  const headers = { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) };
  const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message ?? `HTTP ${r.status}`);
  return j;
}

// ---- connection -------------------------------------------------------------------
$('#connect-form').addEventListener('submit', async e => {
  e.preventDefault();
  keys.reader = $('#k-reader').value.trim();
  keys.admin = $('#k-admin').value.trim() || null;
  $('#k-reader').value = ''; $('#k-admin').value = '';
  await connect();
});

async function connect() {
  try {
    judgeInfo = await api('/v1/judge');
    activePolicy = (await api('/v1/policies/active')).policy;
    setProv('judge_source', judgeInfo.judge_source ?? (judgeInfo.configured ? 'unreachable' : 'none'));
    $('#conn-status').textContent = `connected · judge ${judgeInfo.configured ? judgeInfo.backend : 'not configured'}`;
    await loadScenarioIds();
    await openStream();
    connected = true;
    await loadReviews();
  } catch (err) { $('#conn-status').textContent = `connection failed: ${err.message}`; }
}

// Authentication is optional (AUTH_MODE). With it off, there is nothing to type: connect straight away.
(async () => {
  try { authMode = (await (await fetch('/v1/auth')).json()).mode ?? 'keys'; } catch { authMode = 'keys'; }
  document.body.dataset.authMode = authMode;
  if (authMode === 'none') {
    $('#connect-form').hidden = true;
    $('#auth-off').hidden = false;
    await connect();
    $('#conn-status-none').textContent = $('#conn-status').textContent;
  }
})();

async function openStream() {
  es?.close();
  const { token } = await api('/v1/stream/tokens', { method: 'POST' });
  es = new EventSource(`/v1/stream?token=${encodeURIComponent(token)}&cursor=${encodeURIComponent(cursor)}`);
  for (const kind of ['event', 'evaluation', 'decision', 'coverage_gap', 'evaluation_expired', 'run', 'outcome', 'review'])
    es.addEventListener(kind, m => onRecord(JSON.parse(m.data)));
  // Tokens are single-use: reconnect with a fresh token and resume from the last cursor.
  es.onerror = () => { es.close(); setTimeout(() => openStream().catch(() => undefined), 1000); };
}

function onRecord(rec) {
  cursor = rec.cursor; lastAt = Date.now();
  const p = rec.payload;
  // A new decision may have opened a review task; a review record means one was resolved.
  if (rec.kind === 'decision' || rec.kind === 'review') scheduleReviews();
  if (rec.kind === 'review') return;
  if (rec.kind === 'event') {
    if (evicted.has(p.event_id)) return;
    const r = rows.get(p.event_id) ?? { evaluations: [], decisions: [], outcomes: [] };
    r.event = p; rows.set(p.event_id, r); draw(p.event_id);
  } else if (rec.kind === 'evaluation') {
    if (evicted.has(p.event_id)) { addEval(archive, p); scheduleKpis(); return; }
    const r = rows.get(p.event_id); if (!r) return;
    r.evaluations.push(p); if (p.judge_source) setProv('judge_source', p.judge_source); draw(p.event_id);
  } else if (rec.kind === 'decision') {
    if (evicted.has(p.event_id)) { addDecision(archive, p, answered); scheduleKpis(); return; }
    const r = rows.get(p.event_id); if (!r) return;
    r.decisions.push(p);
    for (const k of ['source_mode', 'judge_source', 'tool_environment', 'enforcement_mode']) if (p.provenance?.[k]) setProv(k, p.provenance[k]);
    draw(p.event_id);
  } else if (rec.kind === 'outcome') {
    // Independent read-back of an executed operation, attached to the post_tool event that started it (RFC §8).
    const r = rows.get(p.event_id); if (!r) return;
    (r.outcomes ??= []).push(p); draw(p.event_id);
  } else if (rec.kind === 'evaluation_expired') { counts.expired++; }
  else if (rec.kind === 'coverage_gap') { counts.gaps++; }
  scheduleKpis();
  if (selected === p.event_id) inspect(selected);
}

function setProv(k, v) {
  const el = document.querySelector(`[data-provenance="${k}"] i`);
  if (el) el.textContent = v;
  if (k === 'judge_source') {
    const typesafe = String(v).startsWith('typesafe:');
    el?.parentElement.classList.toggle('warn', !typesafe);
    $('#judge-note').innerHTML = typesafe
      ? 'Judge: TypeSafe hosted Jev (metered).'
      : `Judge: <code>${esc(v)}</code>, an open model served over the Jev protocol. It is <b>not</b> TypeSafe's Jev; answers are uncalibrated unless the policy says otherwise.`;
  }
}

// ---- stream rows ---------------------------------------------------------------------
const EVALUATED = new Set(['pre_input', 'post_generation', 'pre_tool', 'post_tool']);
function draw(eventId) {
  const r = rows.get(eventId); if (!r?.event) return;
  const ev = r.event;
  const d = r.decisions.filter(x => !x.replay_of).at(-1);
  if (!r.el) {
    r.el = document.createElement('div');
    r.el.className = 'row'; r.el.tabIndex = 0; r.el.setAttribute('role', 'button');
    r.el.addEventListener('click', () => inspect(eventId));
    r.el.addEventListener('keydown', e => { if (e.key === 'Enter') inspect(eventId); });
    $('#stream .lv-empty')?.remove();
    $('#stream').prepend(r.el);
  }
  const status = d ? d.recommended : EVALUATED.has(ev.boundary) ? 'pending' : '';
  const oc = (r.outcomes ?? []).at(-1);
  Object.assign(r.el.dataset, { eventId, boundary: ev.boundary, recommended: d?.recommended ?? '', decidedBy: d?.decided_by ?? '' });
  r.el.className = `row ${['BLOCK', 'STOP'].includes(d?.recommended) ? 'hot' : d && d.recommended !== 'NO_CONFIGURED_RISK' ? 'warm' : ''}`;
  r.el.setAttribute('aria-selected', String(selected === eventId));
  r.el.innerHTML = `<span class="t">${esc(new Date(ev.received_at).toLocaleTimeString())}</span>
    <span class="bd"><span class="chip">${esc(ev.boundary)}</span></span>
    <span class="nm">${esc(ev.tool ?? ev.boundary)} <span class="lv-meta">${esc(ev.run_id)}</span></span>
    <span>${status ? `<span class="chip ${esc(status)}">${esc(status === 'NO_CONFIGURED_RISK' ? 'no configured risk' : status)}</span>` : ''} <span class="lv-meta">${esc(d?.decided_by ?? '')}</span>${oc ? ` <span class="chip oc-${esc(oc.state)}" data-outcome="${esc(oc.state)}">outcome: ${esc(oc.state.replace(/_/g, ' '))}</span>` : ''}</span>`;
  evictRows();
}

// ---- row cap: keep the DOM bounded; the selected row always survives ----------------------
// An evicted row's KPI contributions are folded into `archive` and the row leaves `rows`, so the session KPIs
// keep counting it while the page keeps only a few numbers and its event_id per evicted row.
function evictRows() {
  const els = $('#stream').querySelectorAll('.row');
  let excess = els.length - MAX_ROWS;
  if (excess <= 0) return;
  for (let i = els.length - 1; i >= 0 && excess > 0; i--) {
    const id = els[i].dataset.eventId;
    if (selected != null && id === selected) continue;
    els[i].remove();
    const r = rows.get(id);
    if (r) {
      for (const e of r.evaluations) addEval(archive, e);
      for (const d of r.decisions) addDecision(archive, d, answered);
      rows.delete(id);
    }
    evicted.add(id);
    excess--;
  }
}

// ---- KPIs: from this session's stream; unmeasurable ones say so ------------------------
// Aggregates are the retained rows (recomputed on each render) plus `archive`, the folded evicted rows.
const newAgg = () => ({ i2sJudge: [], i2sRule: [], rtt: [], asked: 0, semOk: 0, decisions: 0, interventions: 0, answered: new Set() });
const archive = newAgg();
let live = newAgg();
const answered = id => live.answered.has(id) || archive.answered.has(id);

function addEval(a, e) {
  if (e.kind !== 'realtime') return;
  const returned = e.status === 'ok' || e.status === 'partial', asked = (e.question_ids ?? []).length > 0;
  // Judge path = the realtime judge call returned an answer (aborted/failed calls are not "fast answers").
  if (returned && asked) a.answered.add(e.evaluation_id);
  if (returned && e.judge_http_rtt_ms != null) a.rtt.push(e.judge_http_rtt_ms);
  // Semantic coverage counts only evaluations that asked the judge something.
  // Covered = every required signal arrived (ok, or partial with all required answers present).
  if (asked) { a.asked++; if (e.status === 'ok' || (e.status === 'partial' && (e.required_question_ids ?? []).every(q => e.signals?.[q]))) a.semOk++; }
}

// RFC §11.2: judge path and rule-only path are reported separately, never mixed.
function addDecision(a, d, isAnswered) {
  if (d.replay_of) return;
  a.decisions++;
  if (d.recommended !== 'NO_CONFIGURED_RISK') a.interventions++;
  const v = d.timings?.ingest_to_signal_ms;
  if (v == null) return;
  if (d.evaluation_id && isAnswered(d.evaluation_id)) a.i2sJudge.push(v);
  if (d.timings.judge_http_rtt_ms == null) a.i2sRule.push(v);
}

// A busy stream re-renders the tiles at most every 100 ms instead of on every record.
let kpiTimer = null;
function scheduleKpis() { kpiTimer ??= setTimeout(() => { kpiTimer = null; renderKpis(); }, 100); }

function renderKpis() {
  live = newAgg();
  for (const r of rows.values()) for (const e of r.evaluations) addEval(live, e);
  for (const r of rows.values()) for (const d of r.decisions) addDecision(live, d, answered);
  const i2sJudge = archive.i2sJudge.concat(live.i2sJudge), i2sRule = archive.i2sRule.concat(live.i2sRule), rtt = archive.rtt.concat(live.rtt);
  const asked = archive.asked + live.asked, semOk = archive.semOk + live.semOk;
  const decisions = archive.decisions + live.decisions, interventions = archive.interventions + live.interventions;
  const tiles = [
    ['i2s_judge_p95', 'ingest → signal p95, judge path', ms(nearestRank(i2sJudge, 0.95)), `measured · n=${i2sJudge.length} · p50 ${ms(nearestRank(i2sJudge, 0.5))}`],
    ['i2s_rule_p95', 'ingest → signal p95, no judge call', ms(nearestRank(i2sRule, 0.95)), `measured · n=${i2sRule.length} (rule-decided or nothing to ask; judge failures excluded from both)`],
    ['rtt_p95', 'judge HTTP RTT p95', ms(nearestRank(rtt, 0.95)), `measured · n=${rtt.length}`],
    ['semantic_coverage', 'semantic coverage', pct(semOk, asked), `required signals delivered / evaluations that asked (n=${asked}) · expired ${counts.expired}`],
    ['interventions', 'recommended interventions', String(interventions), `of ${decisions} decisions · gaps ${counts.gaps}`],
  ];
  const gate = serverMetrics?.gate;
  const enforcing = document.querySelector('[data-provenance="enforcement_mode"] i')?.textContent === 'gate' && gate && gate.gated_attempts > 0;
  if (enforcing) {
    tiles.push(['prevented', 'confirmed prevented actions', String(gate.prevented), `not executed under a deny/hold control (includes fail-closed holds of benign calls) · executed under allow ${gate.executed_under_allow}`]);
    tiles.push(['enforcement_coverage', 'enforcement coverage', pct(gate.enforcement_coverage.numerator, gate.enforcement_coverage.denominator), `gated attempts with control + receipt · ${gate.enforcement_coverage.numerator}/${gate.enforcement_coverage.denominator}`]);
    tiles.push(['preflight_p95', 'SDK preflight p95', ms(gate.sdk_preflight_ms.p95), `measured by the tool wrapper · n=${gate.sdk_preflight_ms.n} · budget 600 ms`]);
  }
  const na = [
    ...(enforcing ? [] : [['prevented', 'confirmed prevented actions', 'not measured', 'shadow mode never enforces']]),
    ['recall', 'P0 recall / false intervention', 'not measured', 'needs independent labels (Gate B eval)'],
    ['llm_baseline', 'LLM-judge baseline (B1)', 'not measured', 'no LLM judge configured (plan D9)'],
  ];
  if (serverMetrics) {
    const cc = serverMetrics.capture_coverage;
    tiles.push(['capture_coverage', 'capture coverage (server)', cc.value == null ? '—' : pct(cc.numerator, cc.denominator), `captured / gateway-attempted tool calls · ${cc.numerator}/${cc.denominator}`]);
    const o = serverMetrics.outcomes ?? {};
    tiles.push(['outcomes', 'outcome read-back', String(Object.values(o).reduce((a, b) => a + b, 0)), Object.entries(o).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(' · ') || 'none yet']);
  }
  $('#kpis').innerHTML = tiles.map(([id, k, v, s]) => `<div class="kpi" data-kpi="${id}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`).join('')
    + na.map(([id, k, v, s]) => `<div class="kpi na" data-kpi="${id}" data-baseline-status="not_measured"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`).join('');
}
// Headless probe hook (tests/probe/live-evict.html): only defined when the probe page sets window.__jevTest.
if (window.__jevTest) window.__jevTest.rowCount = () => rows.size;
setInterval(async () => { if (!connected) return; try { serverMetrics = await api('/v1/metrics'); renderKpis(); } catch { /* keep last */ } }, 3000);
setInterval(() => { $('#lag').textContent = lastAt ? `last record ${Math.round((Date.now() - lastAt) / 1000)} s ago` : ''; }, 1000);

// ---- scenarios --------------------------------------------------------------------------
const FALLBACK_SCENARIOS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'F1'];
let scenarioIds = FALLBACK_SCENARIOS;
async function loadScenarioIds() {
  try { const r = await api('/v1/sandbox/scenarios'); if (Array.isArray(r.scenario_ids) && r.scenario_ids.length) scenarioIds = r.scenario_ids; }
  catch { scenarioIds = FALLBACK_SCENARIOS; }
  renderScenarioButtons();
}
function renderScenarioButtons() {
  const ids = scenarioIds;
  const canRun = authMode === 'none' || Boolean(keys.admin);
  $('#scenario-buttons').innerHTML = ids.map(id => `<button class="btn" data-scenario="${id}" ${canRun ? '' : 'disabled title="needs an admin key"'}>${id}</button>`).join(' ');
  for (const b of document.querySelectorAll('[data-scenario]')) b.addEventListener('click', async () => {
    try { const r = await api('/v1/sandbox/runs', { method: 'POST', body: { scenario: b.dataset.scenario }, role: 'admin' }); $('#run-status').textContent = `started ${r.run_id}`; }
    catch (e) { $('#run-status').textContent = `run failed: ${e.message}`; }
  });
}

// ---- inspector --------------------------------------------------------------------------
function sigCard(qid, s, source) {
  const head = `<div class="h"><b class="mono">${esc(qid)}</b><span class="chip">${esc(s.type)}</span>
    <span class="chip" title="no calibration is active for this judge">${s.p_calibrated == null ? 'uncalibrated' : 'calibrated'}</span>
    <span class="lv-meta">judge answer · ${esc(source)}</span></div>`;
  let body = '';
  if (s.type === 'noul') body = `<div class="lv-meta">p = ${p3(s.raw_probability)} (no vendor confidence for Noul)</div><div class="bar"><i style="width:${(s.raw_probability ?? 0) * 100}%"></i></div>`;
  else body = `<div class="lv-meta">${s.type === 'score' ? `score ${p3(s.score)} · ` : `choice ${esc(s.choice)} · `}vendor confidence ${p3(s.vendor_confidence)} · local margin ${p3(s.margin_local)}</div>
    <div class="dist">${Object.entries(s.probabilities ?? {}).map(([o, p]) => `<span>${esc(s.legend?.[o] ? `${o} ${s.legend[o]}` : o)}</span><span class="bar"><i style="width:${p * 100}%"></i></span><span class="mono">${p3(p)}</span>`).join('')}</div>`;
  return `<div class="sig" data-signal="${esc(qid)}" data-judge-source="${esc(source)}">${head}${body}</div>`;
}

async function inspect(eventId) {
  selected = eventId;
  for (const r of rows.values()) r.el?.setAttribute('aria-selected', String(r.event?.event_id === eventId));
  const r = rows.get(eventId); if (!r) return;
  const ev = r.event, d = r.decisions.filter(x => !x.replay_of).at(-1);
  const rt = r.evaluations.find(e => e.kind === 'realtime'), diag = r.evaluations.find(e => e.kind === 'diagnostic');
  let snap = null;
  const evalForSnap = rt ?? diag;
  if (evalForSnap) snap = (await api(`/v1/evaluations/${encodeURIComponent(evalForSnap.evaluation_id)}`).catch(() => null))?.snapshot ?? null;
  const out = [];
  out.push(`<div class="lv-meta">${esc(ev.run_id)} · ${esc(ev.boundary)} · ${esc(ev.tool ?? '')} · producer ${esc(ev.producer_id)}#${esc(ev.producer_seq)} · via ${esc(ev.ingest_path)}</div>`);
  if (ev.boundary === 'post_tool') {
    if (ev.attributes?.control_id) out.push(`<p class="note ${ev.attributes.receipt_status === 'executed' ? 'info' : 'bad'}" data-control-action="${esc(ev.attributes.control_action)}">Gate: control <b>${esc(ev.attributes.control_action)}</b> (${esc(ev.attributes.control_id)}) · gateway receipt <b>${esc(ev.attributes.receipt_status)}</b> · SDK preflight ${esc(ev.attributes.sdk_preflight_ms)} ms.${ev.attributes.receipt_status === 'not_executed' ? ' The side effect did not happen: this is a confirmed prevention, verified by the gateway.' : ''}</p>`);
    out.push(`<p class="note ${ev.result_status === 'error' ? 'warn' : 'info'}">Tool reported: <b>${esc(ev.result_status ?? 'no result')}</b>${ev.attributes?.receipt_status ? ` · gateway receipt: ${esc(ev.attributes.receipt_status)}` : ''}. The tool's own report is not proof of the business result.</p>`);
    const ocs = r.outcomes ?? [];
    out.push(ocs.length
      ? `<h3>Independent read-back (outcome verifier)</h3><ul>${ocs.map(o => `<li><span class="chip oc-${esc(o.state)}">${esc(o.state)}</span> ${esc(o.source ?? '')} <span class="lv-meta">${esc(JSON.stringify(o.checked ?? {}))}</span></li>`).join('')}</ul>`
      : `<p class="lv-meta">${ev.attributes?.receipt_status === 'executed' && ['payments.execute', 'email.send'].includes(ev.tool) ? 'Read-back pending…' : 'No side effect to verify.'}</p>`);
  }
  if (!d) out.push(EVALUATED.has(ev.boundary) ? '<p class="note info">Pending: the decision has not been recorded yet.</p>' : '<p class="lv-meta">Lifecycle event (not evaluated).</p>');
  else {
    out.push(`<p><span class="big chip ${esc(d.recommended)}">${esc(d.recommended === 'NO_CONFIGURED_RISK' ? 'no configured risk' : d.recommended)}</span> decided by <b>${esc(d.decided_by)}</b></p>`);
    out.push(`<dl class="kv"><dt>would have</dt><dd>${esc(d.would_have ?? '—')}</dd><dt>enforced action</dt><dd>${esc(d.enforced_action ?? 'none (shadow: advisory only)')}</dd>
      <dt>policy</dt><dd>${esc(d.policy_version)}</dd><dt>semantic mode</dt><dd>${d.semantic?.calibrated ? 'calibrated' : 'experimental (signals shown, not acted on)'}</dd></dl>`);
    if (d.recommended === 'NO_CONFIGURED_RISK') out.push('<p class="note info">No configured risk found. This is not a statement that the action is safe.</p>');
    if (d.decided_by === 'judge_unavailable') out.push('<p class="note bad">A required judge signal was unavailable. No answer is not treated as low risk.</p>');
    if (d.reasons?.length) out.push(`<h3>Reasons</h3><ul>${d.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`);
    out.push(`<h3>Hard rules (authoritative, code)</h3><dl class="kv">${(d.rule_results ?? []).map(x => `<dt>${esc(x.rule_id)}</dt><dd>${esc(x.verdict)} · ${esc(x.reason)} · ${esc(x.authoritative_source)}</dd>`).join('') || '<dd>none applicable</dd>'}</dl>`);
    if (d.coverage_gaps?.length) out.push(`<h3>Coverage gaps</h3><ul>${d.coverage_gaps.map(g => `<li>${esc(g)}</li>`).join('')}</ul>`);
    const t = d.timings ?? {};
    out.push(`<h3>Measured timings</h3><dl class="kv"><dt>ingest→signal</dt><dd>${ms(t.ingest_to_signal_ms)}</dd><dt>snapshot</dt><dd>${ms(t.snapshot_ms)}</dd><dt>rules</dt><dd>${ms(t.rules_ms)}</dd><dt>judge HTTP RTT</dt><dd>${ms(t.judge_http_rtt_ms)}</dd><dt>policy</dt><dd>${ms(t.policy_ms)}</dd></dl>`);
  }
  for (const [label, e] of [['Realtime judge evaluation', rt], ['Diagnostic evaluation (off the decision path)', diag]]) {
    if (!e) continue;
    out.push(`<h3>${label}</h3><dl class="kv"><dt>status</dt><dd>${esc(e.status)}</dd><dt>judge</dt><dd>${esc(e.judge_source ?? '—')}</dd>
      <dt>HTTP RTT</dt><dd>${ms(e.judge_http_rtt_ms)} (server-reported ${ms(e.vendor_latency_ms)})</dd><dt>billing</dt><dd>${esc(e.billing)}</dd>
      <dt>usage</dt><dd>${e.usage ? `${e.usage.input_tokens ?? '?'} in / ${e.usage.output_tokens ?? '?'} out` : '—'}</dd>
      <dt>required</dt><dd>${esc(e.required_question_ids.join(', ') || 'none')}</dd></dl>`);
    if (e.errors?.length) out.push(`<p class="note warn">${e.errors.map(esc).join('<br>')}</p>`);
    out.push(Object.entries(e.signals ?? {}).map(([q, s]) => sigCard(q, s, e.judge_source ?? 'unknown judge')).join(''));
  }
  if (snap) {
    out.push(`<h3>Evidence supplied to the judge</h3><ul>${snap.evidence.map(x => `<li><span class="chip">${esc(x.kind)}</span> <span class="lv-meta">${esc(x.authenticity)} · authority ${esc(x.instruction_authority)}${x.truncated ? ' · truncated' : ''}</span><br>${esc(x.excerpt)}</li>`).join('')}</ul>`);
    if (snap.missing_evidence.length) out.push(`<p class="note warn">Missing evidence: ${snap.missing_evidence.map(esc).join(', ')}</p>`);
    out.push(`<details><summary>Judge view (${snap.judge_view.token_estimate} est. tokens${snap.judge_view.truncated ? ', truncated' : ''})</summary><pre class="json">${esc(snap.judge_view.state)}</pre></details>`);
  }
  if (d && activePolicy) out.push(replayBlock(d));
  if (d && (rt ?? diag)) out.push(`<p><button class="btn" data-model-reeval>Re-ask the judge on this frozen snapshot (a new, real model call)</button></p><div id="reeval-out"></div>`);
  if (d) out.push(`<details><summary>Decision record (JSON)</summary><pre class="json">${esc(JSON.stringify(d, null, 2))}</pre></details>`);
  $('#inspector').innerHTML = out.join('');
  $('#inspector [data-replay-run]')?.addEventListener('click', () => runReplay(d));
  $('#inspector [data-model-reeval]')?.addEventListener('click', async () => {
    try {
      const x = (await api('/v1/replays', { method: 'POST', body: { kind: 'model_reeval', decision_ids: [d.decision_id] } })).results[0];
      $('#reeval-out').innerHTML = x.error ? `<p class="note bad">${esc(x.error)}</p>` : `<p class="note info" data-reeval-out>New evaluation ${esc(x.after.evaluation_id)} (${esc(x.after.status)}): <b>${esc(x.after.recommended)}</b>. The original evaluation and decision are unchanged.<br>${Object.entries(x.after.signals ?? {}).map(([q, s]) => `${esc(q)} ${s.type === 'noul' ? p3(s.raw_probability) : esc(s.choice ?? p3(s.score))}`).join(' · ')}</p>`;
    } catch (e) { $('#reeval-out').innerHTML = `<p class="note bad">${esc(e.message)}</p>`; }
  });
}

function replayBlock(d) {
  const bands = Object.entries(activePolicy.semantic.bands);
  return `<h3>Policy-only replay (reuses stored signals; zero judge calls)</h3>
    <div class="replay">${bands.map(([q, b]) => `<label for="rb-${q}">${esc(q)}</label><input type="range" min="0" max="1" step="0.01" id="rb-${q}" data-band="${esc(q)}" value="${b.review_at}"><output>${b.review_at.toFixed(2)}</output>`).join('')}</div>
    <p><button class="btn" data-replay-run>Replay this decision</button></p><div id="replay-out" data-replay-out></div>`;
}
document.addEventListener('input', e => { const t = e.target.closest?.('[data-band]'); if (t) t.nextElementSibling.textContent = Number(t.value).toFixed(2); });

async function runReplay(d) {
  const policy = structuredClone(activePolicy);
  for (const el of document.querySelectorAll('[data-band]')) policy.semantic.bands[el.dataset.band].review_at = Number(el.value);
  try {
    const r = await api('/v1/replays', { method: 'POST', body: { kind: 'policy_only', decision_ids: [d.decision_id], policy } });
    const x = r.results[0];
    $('#replay-out').innerHTML = x.error ? `<p class="note bad">${esc(x.error)}</p>` : `<p class="note info" data-judge-calls="${r.judge_calls}">
      Before: <b>${esc(x.before.recommended)}</b> (${esc(x.before.decided_by)}, ${esc(x.before.policy_version)})<br>
      After: <b>${esc(x.after.recommended)}</b> (${esc(x.after.decided_by)}, ${esc(x.after.policy_version)})<br>
      Judge calls made by this replay: ${r.judge_calls}.${d.decided_by === 'rule' ? ' A hard-rule decision is not reachable from any band.' : ''}
      ${x.after.semantic && !x.after.semantic.calibrated ? ' Semantic mode is experimental, so bands mark signals but do not change the recommendation until a calibration exists.' : ''}</p>`;
  } catch (e) { $('#replay-out').innerHTML = `<p class="note bad">${esc(e.message)}</p>`; }
}

// ---- review queue (T8) --------------------------------------------------------------------
// Lists open review tasks and resolves them. Resolving writes labels only: it never releases or executes
// a held action and never changes a decision (docs/CONTRACTS.md §10.1). Judge answers are uncalibrated.
let reviewTimer = null, openReview = null;
const canResolve = () => authMode === 'none' || Boolean(keys.admin);
function scheduleReviews() { clearTimeout(reviewTimer); reviewTimer = setTimeout(() => loadReviews().catch(() => undefined), 300); }

async function loadReviews() {
  const { reviews } = await api('/v1/reviews?status=open&limit=200');
  $('#review-count').textContent = `${reviews.length} open`;
  $('#review-sample').disabled = !canResolve();
  const list = $('#review-list');
  if (!reviews.length) list.innerHTML = '<p class="lv-empty">No open reviews.</p>';
  else list.innerHTML = reviews.map(t => `<div class="rv-row" tabindex="0" role="button" data-review-id="${esc(t.review_id)}" aria-selected="${openReview === t.review_id}">
      <span class="nm">${esc(t.body.tool ?? 'generation')} <span class="lv-meta">${esc(t.body.run_id ?? '')}</span></span>
      <span class="chip ${esc(t.body.recommended)}">${esc(t.body.recommended)}</span>
      <span class="lv-meta">${esc(t.body.decided_by)} · ${esc(t.body.path)}${t.body.sample_reason ? ` · ${esc(t.body.sample_reason.replace(/_/g, ' '))}` : ''}</span>
      <span class="lv-meta">${esc(new Date(t.created_at).toLocaleTimeString())}</span></div>`).join('');
  for (const el of list.querySelectorAll('[data-review-id]')) {
    el.addEventListener('click', () => showReview(el.dataset.reviewId));
    el.addEventListener('keydown', e => { if (e.key === 'Enter') showReview(el.dataset.reviewId); });
  }
  if (openReview && !reviews.some(t => t.review_id === openReview)) { openReview = null; $('#review-detail').innerHTML = '<p class="lv-empty">Select a review.</p>'; }
}

function answerInput(qid, q) {
  const opts = q.type === 'noul' ? [['true', 'yes'], ['false', 'no']]
    : q.type === 'choice' ? Object.entries(q.criteria).map(([k, v]) => [k, v ? `${k} — ${v}` : k])
    : q.criteria.map(level => [level, level]);
  return `<select data-answer="${esc(qid)}" data-type="${esc(q.type)}" aria-label="${esc(qid)}"><option value="">skip</option>${opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`;
}

/** A score with the legend label of its nearest level, e.g. "score 1.597 (material)". */
function scoreText(s) {
  const label = s.legend && typeof s.score === 'number' ? s.legend[String(Math.round(s.score))] : null;
  return `score ${p3(s.score)}${label ? ` (${esc(label)})` : ''}`;
}

function judgeAnswer(s) {
  if (!s) return '<span class="lv-meta">no judge answer</span>';
  if (s.type === 'noul') return `<span class="lv-meta">judge: yes-probability ${p3(s.raw_probability)} (uncalibrated)</span>`;
  return `<span class="lv-meta">judge: ${s.type === 'score' ? scoreText(s) : esc(s.choice)} (uncalibrated)</span>`;
}

async function showReview(id) {
  openReview = id;
  for (const el of document.querySelectorAll('[data-review-id]')) el.setAttribute('aria-selected', String(el.dataset.reviewId === id));
  const r = await api(`/v1/reviews/${encodeURIComponent(id)}`);
  const t = r.review, d = r.decision, signals = r.evaluation?.signals ?? {};
  const out = [];
  out.push(`<div class="lv-meta">${esc(t.body.run_id ?? '')} · ${esc(t.body.tool ?? 'generation')} · opened by ${esc(t.body.path)}${t.body.sample_reason ? ` (${esc(t.body.sample_reason.replace(/_/g, ' '))})` : ''}</div>`);
  out.push(`<p><span class="big chip ${esc(t.body.recommended)}">${esc(t.body.recommended)}</span> decided by <b>${esc(t.body.decided_by)}</b></p>`);
  if (t.body.reasons?.length) out.push(`<h3>Reasons</h3><ul>${t.body.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`);
  if (d?.rule_results?.length) out.push(`<h3>Hard rules</h3><dl class="kv">${d.rule_results.map(x => `<dt>${esc(x.rule_id)}</dt><dd>${esc(x.verdict)} · ${esc(x.reason)}</dd>`).join('')}</dl>`);
  if (r.snapshot) out.push(`<h3>What the judge saw (frozen snapshot)</h3><pre class="json" data-review-state>${esc(r.snapshot.judge_view.state)}</pre>`);
  out.push(`<h3>Your answers</h3>${r.evaluation ? '' : '<p class="lv-meta">This decision had no judge evaluation, so every rubric question for its boundary is offered. Skip what does not apply.</p>'}`);
  out.push(Object.entries(r.questions).map(([qid, q]) => `<div class="rv-q" data-question="${esc(qid)}"><div class="h"><b>${esc(qid)}</b> <span class="chip">${esc(q.type)}</span> ${judgeAnswer(signals[qid])}</div>
    <p class="ins">${esc(q.instructions)}</p>${answerInput(qid, q)}</div>`).join(''));
  const ok = canResolve();
  out.push(`<div class="rv-actions"><button class="btn allow" type="button" data-resolve="allow" ${ok ? '' : 'disabled'}>Allow</button>
    <button class="btn deny" type="button" data-resolve="deny" ${ok ? '' : 'disabled'}>Deny</button>
    <span class="lv-meta" id="review-status">${ok ? 'Records labels; does not release the action.' : 'Resolving needs the admin key: reconnect with it.'}</span></div>`);
  $('#review-detail').innerHTML = out.join('');
  for (const b of document.querySelectorAll('#review-detail [data-resolve]')) b.addEventListener('click', () => resolveReview(t.review_id, b.dataset.resolve));
}

async function resolveReview(id, outcome) {
  const answers = {};
  for (const el of document.querySelectorAll('#review-detail [data-answer]')) {
    if (!el.value) continue;
    answers[el.dataset.answer] = el.dataset.type === 'noul' ? el.value === 'true' : el.value;
  }
  for (const b of document.querySelectorAll('#review-detail [data-resolve]')) b.disabled = true;
  try {
    const r = await api(`/v1/reviews/${encodeURIComponent(id)}/resolve`, { method: 'POST', role: 'admin', body: { outcome, answers } });
    openReview = null;
    $('#review-detail').innerHTML = `<p class="note info" data-review-resolved="${esc(r.status)}">Resolved (${esc(outcome)}): ${r.labels.length} label(s) recorded. The held action was not released.</p>`;
    await loadReviews();
  } catch (e) {
    $('#review-status').textContent = e.message;
    for (const b of document.querySelectorAll('#review-detail [data-resolve]')) b.disabled = !canResolve();
  }
}

$('#review-sample').addEventListener('click', async () => {
  try {
    const { opened } = await api('/v1/reviews/sample', { method: 'POST', role: 'admin', body: {} });
    $('#review-count').textContent = `sampled ${opened.length}`;
    await loadReviews();
  } catch (e) { $('#review-count').textContent = e.message; }
});

renderKpis();
