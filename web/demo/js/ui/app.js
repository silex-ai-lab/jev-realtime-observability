// Live console controller: a simulated clock streams spans through the engine;
// every routed span becomes a row, a verdict envelope and part of the KPIs.

import { DEFAULT_POLICY, BATTERY } from '../engine/types.js';
import { TENANT, buildStream, makeBackground, scenarioById, ALL_SCENARIOS } from '../engine/scenarios.js';
import { route, runStream } from '../engine/router.js';
import { buildState } from '../engine/state.js';
import { validatePolicy } from '../engine/policy.js';
import { computeKpis } from '../engine/kpi.js';
import { renderInspector } from './inspector.js';
import { initReplay } from './replay.js';
import { initStudio } from './studio.js';
import { $, $$, esc, chip, decisionChip, deepClone, fmtClock, fmtMs, fmtPct, fmtUsd } from './util.js';

const params = new URLSearchParams(location.search);
const seedParam = Number.parseInt(params.get('seed') ?? '', 10);
const SEED = Number.isFinite(seedParam) ? seedParam : 7;
const AUTOPLAY = params.get('autoplay') !== '0';

// ---- state -------------------------------------------------------------
let policy = deepClone(DEFAULT_POLICY);
const policies = new Map([[policy.version, policy]]);
const stream = buildStream(SEED);
const titles = new Map([
  ...ALL_SCENARIOS.map(t => [t.trace_id, t.title]),
  ...makeBackground(SEED).map(t => [t.trace_id, t.title]),
]);
const rows = [];           // { seq, span, env, fault }
let seq = 0, cursor = 0, simTime = 0, playing = false, speed = 1, injectCount = 0;
let selectedSeq = null, fault = null, lastFrame = null;

const baseTrace = id => String(id).split('~')[0];
const historyFor = row => rows.filter(r => r.seq < row.seq && r.span.trace_id === row.span.trace_id).map(r => r.env);

const app = {
  tenant: TENANT,
  seed: SEED,
  policy: () => policy,
  rows: () => rows,
  history: historyFor,
  rememberPolicy(p) { policies.set(p.version, p); },
  setPolicy(p) {
    policy = p; policies.set(p.version, p);
    replay?.onPolicy();
    if (selectedSeq != null) select(selectedSeq);
  },
};

// ---- routing -------------------------------------------------------------
function routeSpan(span, f = fault) {
  if (!span.boundary) return null;
  const applied = span.fault ?? f ?? null;
  const row = { seq: ++seq, span, fault: applied };
  const history = rows.filter(r => r.span.trace_id === span.trace_id).map(r => r.env);
  row.env = route(span, { tenant: TENANT, policy, seed: SEED, history, faults: { jev: applied } });
  if (!row.env) return null;
  rows.push(row);
  addRow(row);
  return row;
}

function inject(id) {
  const tr = scenarioById(id);
  if (!tr) return [];
  const k = ++injectCount;
  const sfx = s => `${s}~i${k}`;
  const made = tr.spans.map((s, i) => ({
    ...deepClone(s), trace_id: sfx(s.trace_id), span_id: sfx(s.span_id),
    parent_span_id: s.parent_span_id ? sfx(s.parent_span_id) : null, t_ms: Math.round(simTime) + i * 40,
  }));
  titles.set(made[0].trace_id, tr.title);
  const routed = made.map(s => routeSpan(s)).filter(Boolean);
  const focus = [...routed].reverse().find(r => r.env.decision !== 'ALLOW' || r.env.alert) ?? routed.at(-1);
  if (focus) select(focus.seq);
  renderKpis();
  return routed.map(r => r.env);
}

function advanceTo(t) {
  simTime = t;
  let n = 0;
  while (cursor < stream.length && stream[cursor].t_ms <= simTime) { if (routeSpan(stream[cursor++])) n++; }
  if (n) { renderKpis(); if (selectedSeq == null && rows.length) select(rows[0].seq); }
  if (cursor >= stream.length && playing) { setPlaying(false); $('#clock').textContent = `${fmtClock(simTime)} · stream complete`; return; }
  $('#clock').textContent = fmtClock(simTime);
}

function step() {
  while (cursor < stream.length && !stream[cursor].boundary) cursor++;
  if (cursor < stream.length) advanceTo(stream[cursor].t_ms);
}

function flush() { if (stream.length) advanceTo(stream.at(-1).t_ms); }

function frame(ts) {
  if (playing) {
    if (lastFrame != null) advanceTo(simTime + (ts - lastFrame) * speed);
    lastFrame = ts;
    requestAnimationFrame(frame);
  } else lastFrame = null;
}

function setPlaying(on) {
  playing = on;
  const b = $('[data-play]');
  b.setAttribute('aria-pressed', String(on));
  b.textContent = on ? '❚❚ Pause' : '▶ Play';
  if (on) requestAnimationFrame(frame);
}

// ---- rendering -------------------------------------------------------------
const streamEl = $('#stream'), inspEl = $('#inspector');
const fBoundary = $('#f-boundary'), fDecision = $('#f-decision'), fScen = $('#f-scen'), fAgent = $('#f-agent'), fRisk = $('#f-risk');

function visible(row) {
  const d = fDecision.value, b = fBoundary.value;
  if (b && row.env.boundary !== b) return false;
  if (fAgent.value && row.env.agent !== fAgent.value) return false;
  if (fRisk.value && row.env.risk?.label !== fRisk.value) return false;
  if (d === 'nonallow' && row.env.decision === 'ALLOW' && !row.env.alert) return false;
  if (d && d !== 'nonallow' && row.env.decision !== d) return false;
  if (fScen.checked && !row.span.scenario) return false;
  return true;
}

function addRow(row) {
  const { env, span } = row;
  streamEl.querySelector('.jv-empty')?.remove();
  const el = document.createElement('div');
  const hot = ['BLOCK', 'STOP'].includes(env.decision) ? 'risk' : env.decision !== 'ALLOW' || env.alert ? 'review' : '';
  el.className = `jv-row ${hot} fresh`;
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  Object.assign(el.dataset, {
    seq: row.seq, spanId: env.span_id, scenario: span.scenario ?? '', boundary: env.boundary,
    decision: env.decision, decidedBy: env.decided_by,
  });
  el.innerHTML = `<span class="t">${fmtClock(span.t_ms ?? 0).slice(2)}</span>
    <span class="bd">${chip(env.boundary.replace('_', ' '), 'b')}</span>
    <span class="name">${esc(env.tool?.name ?? span.name)}${span.scenario ? ' ' + chip(span.scenario, 'sc') : ''}<small>${esc(baseTrace(env.trace_id))}</small></span>
    <span>${decisionChip(env.decision)} <small class="jv-meta">${esc(env.decided_by)}${env.alert ? ' · alert' : ''}</small></span>
    <span class="ms">${fmtMs(env.decision_latency_ms)}</span>`;
  el.hidden = !visible(row);
  streamEl.prepend(el);
}

function applyFilters() { for (const el of $$('.jv-row', streamEl)) el.hidden = !visible(rows.find(r => r.seq === Number(el.dataset.seq))); }

function select(s) {
  selectedSeq = s;
  for (const el of $$('.jv-row', streamEl)) el.setAttribute('aria-selected', String(Number(el.dataset.seq) === s));
  const row = rows.find(r => r.seq === s) ?? null;
  renderInspector(inspEl, row, {
    tenant: TENANT, seed: SEED, history: historyFor,
    policyFor: v => policies.get(v) ?? policy,
    traceTitle: sp => titles.get(sp.trace_id) ?? titles.get(baseTrace(sp.trace_id)) ?? sp.trace_id,
  });
}

const KPI_DEFS = [
  ['p50', 'p50 added gate latency (simulated)', k => fmtMs(k.p50_ms), k => k.p50_ms, 'pre_tool spans · report budget'],
  ['p95', 'p95 added gate latency (simulated)', k => fmtMs(k.p95_ms), k => k.p95_ms, 'report POC target ≤ 500 ms'],
  ['blocks', 'Blocks', k => String(k.blocks ?? 0), k => k.blocks, k => `holds ${k.holds ?? 0} · alerts ${k.alerts ?? 0}`],
  ['review_rate', 'Human review rate', k => fmtPct(k.review_rate), k => k.review_rate, 'REVIEW + HOLD + ALERT + STOP'],
  ['false_block', 'False-block rate', k => fmtPct(k.false_block_rate), k => k.false_block_rate, k => `vs scenario labels · n=${k.labelled_allow ?? 0}`],
  ['coverage', 'Pre-tool coverage', k => fmtPct(k.coverage), k => k.coverage, k => `${k.pre_tool ?? 0} pre_tool spans routed`],
  ['cost', 'Jev $ / 1k judgments (simulated tokens)', k => fmtUsd(k.jev_cost_per_1k_usd), k => k.jev_cost_per_1k_usd, 'vendor list price, report p.3'],
];
const TIP = {
  p50: 'Nearest-rank percentile of decision_latency_ms over pre_tool envelopes. Simulated from the report budget, not measured.',
  p95: 'Nearest-rank percentile of decision_latency_ms over pre_tool envelopes. Simulated from the report budget, not measured.',
  blocks: 'Count of BLOCK decisions in this page\'s log (monitor-mode decisions included, marked would_have).',
  review_rate: 'Share of routed spans that need a human: REVIEW, HOLD, ALERT or STOP.',
  false_block: 'Spans the demo author labelled ALLOW that were BLOCK / HOLD / STOP. Scenario labels, not a benchmark.',
  coverage: 'pre_tool envelopes with an explicit decision and decided_by, over all pre_tool envelopes (report target: 100%).',
  cost: '$0.042 per M input tokens (vendor list price quoted in the report), output free; token counts simulated.',
};

function renderKpis() {
  const envs = rows.map(r => r.env);
  const k = envs.length ? computeKpis(envs) : {};
  $('#kpis').innerHTML = KPI_DEFS.map(([id, label, show, raw, sub]) => {
    const val = raw(k);
    return `<div class="jv-kpi" data-kpi="${id}" data-value="${val ?? ''}" title="${esc(TIP[id])}">
      <div class="k">${esc(label)}</div><div class="v">${envs.length ? esc(show(k)) : '—'}</div>
      <div class="s">${esc(typeof sub === 'function' ? sub(k) : sub)}</div></div>`;
  }).join('');
}

// ---- wiring -------------------------------------------------------------
function showTab(name) {
  for (const b of $$('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of $$('[data-panel]')) p.hidden = p.dataset.panel !== name;
  if (name === 'replay') replay.onShow(rows.find(r => r.seq === selectedSeq)?.env.span_id);
}

$$('[data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('[data-play]').addEventListener('click', () => setPlaying(!playing));
$('[data-step]').addEventListener('click', step);
$$('[data-speed]').forEach(b => b.addEventListener('click', () => {
  speed = Number(b.dataset.speed);
  $$('[data-speed]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
}));
$$('[data-inject]').forEach(b => b.addEventListener('click', () => inject(b.dataset.inject)));
$('[data-fault]').addEventListener('change', e => { fault = e.target.value || null; });
[fBoundary, fDecision, fScen, fAgent, fRisk].forEach(x => x.addEventListener('change', applyFilters));
streamEl.addEventListener('click', e => { const r = e.target.closest('.jv-row'); if (r) select(Number(r.dataset.seq)); });
streamEl.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const r = e.target.closest('.jv-row'); if (r) { e.preventDefault(); select(Number(r.dataset.seq)); }
});

const replay = initReplay(app);
const studio = initStudio(app);
streamEl.innerHTML = '<p class="jv-empty">Press Play to stream the agent\'s spans, or inject a scenario.</p>';
renderKpis();

const latestRow = spanId => [...rows].reverse().find(r => r.env.span_id === spanId) ?? null;
window.__jevDemo = {
  ready: true,
  seed: SEED,
  engine: { route, runStream, buildState, computeKpis, validatePolicy, BATTERY, TENANT },
  policy: () => deepClone(policy),
  setPolicy(p) {
    const v = validatePolicy(p);
    if (!v.ok) return v;
    app.setPolicy(deepClone(p)); studio.draw();
    return v;
  },
  log: () => rows.map(r => r.env),
  kpis: () => computeKpis(rows.map(r => r.env)),
  inject,
  setFault(kind) { fault = kind || null; $('[data-fault]').value = kind || ''; },
  flush,
  select(spanId) { const r = latestRow(spanId); if (r) select(r.seq); return !!r; },
  replay(spanId, p) { const r = latestRow(spanId); return r ? replay.replay(r.seq, p) : null; },
};

if (AUTOPLAY) setPlaying(true);
