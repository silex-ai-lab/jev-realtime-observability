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
const rows = new Map();        // event_id → { event, evaluations: [], decisions: [], el }
let cursor = '0', es = null, selected = null, lastAt = null, judgeInfo = null, activePolicy = null;
const counts = { expired: 0, gaps: 0 };

async function api(path, { method = 'GET', body, role = 'reader' } = {}) {
  const key = keys[role] ?? keys.reader;
  const r = await fetch(path, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
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
  try {
    judgeInfo = await api('/v1/judge');
    activePolicy = (await api('/v1/policies/active')).policy;
    setProv('judge_source', judgeInfo.judge_source ?? (judgeInfo.configured ? 'unreachable' : 'none'));
    $('#conn-status').textContent = `connected · judge ${judgeInfo.configured ? judgeInfo.backend : 'not configured'}`;
    renderScenarioButtons();
    await openStream();
  } catch (err) { $('#conn-status').textContent = `connection failed: ${err.message}`; }
});

async function openStream() {
  es?.close();
  const { token } = await api('/v1/stream/tokens', { method: 'POST' });
  es = new EventSource(`/v1/stream?token=${encodeURIComponent(token)}&cursor=${encodeURIComponent(cursor)}`);
  for (const kind of ['event', 'evaluation', 'decision', 'coverage_gap', 'evaluation_expired', 'run'])
    es.addEventListener(kind, m => onRecord(JSON.parse(m.data)));
  // Tokens are single-use: reconnect with a fresh token and resume from the last cursor.
  es.onerror = () => { es.close(); setTimeout(() => openStream().catch(() => undefined), 1000); };
}

function onRecord(rec) {
  cursor = rec.cursor; lastAt = Date.now();
  const p = rec.payload;
  if (rec.kind === 'event') {
    const r = rows.get(p.event_id) ?? { evaluations: [], decisions: [] };
    r.event = p; rows.set(p.event_id, r); draw(p.event_id);
  } else if (rec.kind === 'evaluation') {
    const r = rows.get(p.event_id); if (!r) return;
    r.evaluations.push(p); if (p.judge_source) setProv('judge_source', p.judge_source); draw(p.event_id);
  } else if (rec.kind === 'decision') {
    const r = rows.get(p.event_id); if (!r) return;
    r.decisions.push(p);
    for (const k of ['source_mode', 'judge_source', 'tool_environment', 'enforcement_mode']) if (p.provenance?.[k]) setProv(k, p.provenance[k]);
    draw(p.event_id);
  } else if (rec.kind === 'evaluation_expired') { counts.expired++; }
  else if (rec.kind === 'coverage_gap') { counts.gaps++; }
  renderKpis();
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
  Object.assign(r.el.dataset, { eventId, boundary: ev.boundary, recommended: d?.recommended ?? '', decidedBy: d?.decided_by ?? '' });
  r.el.className = `row ${['BLOCK', 'STOP'].includes(d?.recommended) ? 'hot' : d && d.recommended !== 'NO_CONFIGURED_RISK' ? 'warm' : ''}`;
  r.el.setAttribute('aria-selected', String(selected === eventId));
  r.el.innerHTML = `<span class="t">${esc(new Date(ev.received_at).toLocaleTimeString())}</span>
    <span class="bd"><span class="chip">${esc(ev.boundary)}</span></span>
    <span class="nm">${esc(ev.tool ?? ev.boundary)} <span class="lv-meta">${esc(ev.run_id)}</span></span>
    <span>${status ? `<span class="chip ${esc(status)}">${esc(status === 'NO_CONFIGURED_RISK' ? 'no configured risk' : status)}</span>` : ''} <span class="lv-meta">${esc(d?.decided_by ?? '')}</span></span>`;
}

// ---- KPIs: from this session's stream; unmeasurable ones say so ------------------------
function renderKpis() {
  const decisions = [...rows.values()].flatMap(r => r.decisions.filter(d => !d.replay_of));
  const evals = [...rows.values()].flatMap(r => r.evaluations.filter(e => e.kind === 'realtime'));
  // RFC §11.2: judge path and rule-only path are reported separately, never mixed.
  // Judge path = the realtime judge call returned an answer (aborted/failed calls are not "fast answers").
  const answered = new Set([...rows.values()].flatMap(r => r.evaluations).filter(e => e.kind === 'realtime' && (e.status === 'ok' || e.status === 'partial') && (e.question_ids ?? []).length).map(e => e.evaluation_id));
  const judged = decisions.filter(d => d.evaluation_id && answered.has(d.evaluation_id));
  const ruleOnly = decisions.filter(d => d.timings?.judge_http_rtt_ms == null);
  const i2sJudge = judged.map(d => d.timings.ingest_to_signal_ms).filter(v => v != null);
  const i2sRule = ruleOnly.map(d => d.timings.ingest_to_signal_ms).filter(v => v != null);
  const rtt = evals.filter(e => e.status === 'ok' || e.status === 'partial').map(e => e.judge_http_rtt_ms).filter(v => v != null);
  // Semantic coverage counts only evaluations that asked the judge something.
  const asked = evals.filter(e => (e.question_ids ?? []).length > 0);
  // Covered = every required signal arrived (ok, or partial with all required answers present).
  const semOk = asked.filter(e => e.status === 'ok' || (e.status === 'partial' && (e.required_question_ids ?? []).every(q => e.signals?.[q]))).length;
  const interventions = decisions.filter(d => d.recommended !== 'NO_CONFIGURED_RISK').length;
  const tiles = [
    ['i2s_judge_p95', 'ingest → signal p95, judge path', ms(nearestRank(i2sJudge, 0.95)), `measured · n=${i2sJudge.length} · p50 ${ms(nearestRank(i2sJudge, 0.5))}`],
    ['i2s_rule_p95', 'ingest → signal p95, no judge call', ms(nearestRank(i2sRule, 0.95)), `measured · n=${i2sRule.length} (rule-decided or nothing to ask; judge failures excluded from both)`],
    ['rtt_p95', 'judge HTTP RTT p95', ms(nearestRank(rtt, 0.95)), `measured · n=${rtt.length}`],
    ['semantic_coverage', 'semantic coverage', pct(semOk, asked.length), `required signals delivered / evaluations that asked (n=${asked.length}) · expired ${counts.expired}`],
    ['interventions', 'recommended interventions', String(interventions), `of ${decisions.length} decisions · gaps ${counts.gaps}`],
  ];
  const na = [
    ['prevented', 'confirmed prevented actions', 'not measured', 'shadow mode never enforces'],
    ['recall', 'P0 recall / false intervention', 'not measured', 'needs independent labels (Gate B eval)'],
    ['llm_baseline', 'LLM-judge baseline (B1)', 'not measured', 'no LLM judge configured (plan D9)'],
  ];
  $('#kpis').innerHTML = tiles.map(([id, k, v, s]) => `<div class="kpi" data-kpi="${id}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`).join('')
    + na.map(([id, k, v, s]) => `<div class="kpi na" data-kpi="${id}" data-baseline-status="not_measured"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`).join('');
}
setInterval(() => { $('#lag').textContent = lastAt ? `last record ${Math.round((Date.now() - lastAt) / 1000)} s ago` : ''; }, 1000);

// ---- scenarios --------------------------------------------------------------------------
function renderScenarioButtons() {
  const ids = ['S1', 'S2', 'S3', 'S4', 'S6', 'F1'];
  $('#scenario-buttons').innerHTML = ids.map(id => `<button class="btn" data-scenario="${id}" ${keys.admin ? '' : 'disabled title="needs an admin key"'}>${id}</button>`).join(' ');
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
  if (ev.boundary === 'post_tool') out.push(`<p class="note ${ev.result_status === 'error' ? 'warn' : 'info'}">Tool reported: <b>${esc(ev.result_status ?? 'no result')}</b>${ev.attributes?.receipt_status ? ` · gateway receipt: ${esc(ev.attributes.receipt_status)}` : ''}. This is the tool's own report; independent read-back verification arrives in Gate B.</p>`);
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
  if (d) out.push(`<details><summary>Decision record (JSON)</summary><pre class="json">${esc(JSON.stringify(d, null, 2))}</pre></details>`);
  $('#inspector').innerHTML = out.join('');
  $('#inspector [data-replay-run]')?.addEventListener('click', () => runReplay(d));
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

renderKpis();
