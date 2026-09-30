// Replay: re-route one logged span under edited thresholds, side by side.
// Judge answers are keyed by (seed, span_id), so only the policy differs.

import { BATTERY } from '../engine/types.js';
import { route } from '../engine/router.js';
import { validatePolicy } from '../engine/policy.js';
import { $, esc, chip, decisionChip, deepClone, fmtMs } from './util.js';

let counter = 0;

function card(label, env) {
  if (!env) return `<span class="jv-meta">${esc(label)}</span>`;
  return `<div class="jv-meta">${esc(label)}</div>
    <div style="margin:6px 0">${decisionChip(env.decision)} ${chip(`by ${env.decided_by}`, 'by')}</div>
    <div class="jv-meta mono">${esc(env.policy_version)}</div>
    <div class="jv-meta">${(env.reasons ?? []).map(esc).join('; ') || 'no threshold crossed'}</div>
    <div class="jv-meta">gate ${fmtMs(env.decision_latency_ms)}</div>`;
}

export function initReplay(app) {
  const NOUL = BATTERY.filter(q => q.type === 'noul' && app.domain.questions.includes(q.id)).map(q => q.id);
  const sel = $('#replay-span'), thr = $('#replay-thr'), err = $('#replay-err');
  const before = $('#replay-before'), after = $('#replay-after'), note = $('#replay-note'), sweepOut = $('#replay-sweep-out');
  let draft = deepClone(app.policy());

  function drawThresholds() {
    thr.innerHTML = NOUL.map(q => ['review_threshold', 'block_threshold'].map(k => {
      const v = draft.thresholds[q][k];
      return `<label for="rt-${q}-${k}">${esc(q)} · ${k.replace('_threshold', '')}</label>
        <input type="range" min="0" max="1" step="0.01" id="rt-${q}-${k}" data-threshold="${q}.${k}" value="${v}">
        <output for="rt-${q}-${k}">${v.toFixed(2)}</output>`;
    }).join('')).join('');
  }

  function refreshSpans(keep) {
    const rows = app.rows().filter(r => r.env);
    const cur = keep ?? sel.value;
    // Scenario spans first (newest first), then background.
    const newest = [...rows].reverse();
    const ordered = [...newest.filter(r => r.span.scenario), ...newest.filter(r => !r.span.scenario)];
    sel.innerHTML = ordered.map(r => `<option value="${esc(r.env.span_id)}">${esc(r.span.scenario ?? 'bg')} · ${esc(r.span.name)} · ${esc(r.env.decision)} · ${esc(r.env.span_id)}</option>`).join('');
    if (cur && ordered.some(r => r.env.span_id === cur)) sel.value = cur;
  }

  // Option values are span ids (unique per routed span; injected copies get a ~iN suffix).
  const selected = () => [...app.rows()].reverse().find(r => r.env.span_id === sel.value) ?? null;

  function replayRow(row, policy) {
    return route(row.span, { tenant: app.tenant, policy, seed: app.seed, history: app.history(row), faults: { jev: row.fault ?? null } });
  }

  function run() {
    const row = selected();
    if (!row) { note.textContent = 'No span yet: play the stream or inject a scenario.'; return null; }
    const v = validatePolicy(draft);
    if (!v.ok) { err.textContent = v.errors.join('; '); return null; }
    err.textContent = '';
    const policy = { ...deepClone(draft), version: `${app.policy().version}+replay-${++counter}` };
    app.rememberPolicy(policy);
    const env = replayRow(row, policy);
    before.dataset.decision = row.env.decision; before.innerHTML = card('Before · as logged', row.env);
    after.dataset.decision = env.decision; after.innerHTML = card('After · re-run', env);
    const changed = env.decision !== row.env.decision;
    note.className = `note ${changed ? 'warn' : 'info'}`;
    note.innerHTML = row.env.decided_by === 'rule'
      ? `Decided by a hard rule (${esc((row.env.rule_hits ?? []).map(h => h.id).join(', '))}). Thresholds only move semantic routing; <b>no threshold reaches this decision</b>.`
      : changed ? `The decision changed from <b>${esc(row.env.decision)}</b> to <b>${esc(env.decision)}</b>: this span was routed by semantic thresholds.`
        : 'Same decision under these thresholds.';
    return { before: row.env, after: env };
  }

  function sweep() {
    const row = selected();
    if (!row) return;
    const base = deepClone(draft), seen = {};
    let n = 0, changed = 0;
    for (const q of NOUL) for (let r = 0; r <= 20; r++) for (let b = r + 1; b <= 20; b++) {
      const p = deepClone(base);
      p.thresholds[q] = { review_threshold: r / 20, block_threshold: b / 20 };
      p.version = 'sweep';
      const d = replayRow(row, p).decision;
      n++; seen[d] = (seen[d] ?? 0) + 1; if (d !== row.env.decision) changed++;
    }
    sweepOut.innerHTML = `<h3>Sweep · ${n} valid threshold settings (0.05 steps, one question at a time)</h3>
      <p>Decision changed in <b>${changed}</b> of ${n}. Outcomes: ${Object.entries(seen).map(([d, c]) => `${decisionChip(d)} ${c}`).join(' ')}</p>
      ${row.env.decided_by === 'rule' ? '<p class="note info">A hard-rule decision is invariant to every threshold.</p>' : ''}`;
  }

  thr.addEventListener('input', e => {
    const t = e.target.closest('[data-threshold]'); if (!t) return;
    const [q, k] = t.dataset.threshold.split('.');
    draft.thresholds[q][k] = Number(t.value);
    t.nextElementSibling.textContent = Number(t.value).toFixed(2);
    const v = validatePolicy(draft);
    err.textContent = v.ok ? '' : v.errors.join('; ');
  });
  $('[data-replay-run]').addEventListener('click', run);
  $('#replay-sweep').addEventListener('click', sweep);
  $('#replay-reset').addEventListener('click', () => { draft = deepClone(app.policy()); drawThresholds(); err.textContent = ''; });
  sel.addEventListener('change', () => { before.innerHTML = card('Before · as logged', selected()?.env); after.innerHTML = '<span class="jv-meta">After</span>'; sweepOut.innerHTML = ''; });

  drawThresholds();
  return {
    onShow(focusSpanId) { refreshSpans(focusSpanId); if (!before.dataset.decision) before.innerHTML = card('Before · as logged', selected()?.env); },
    onPolicy() { draft = deepClone(app.policy()); drawThresholds(); },
    // Probe hook: replay a row by seq under a full policy object.
    replay(seq, policy) {
      const row = app.rows().find(r => r.seq === seq); if (!row) return null;
      // A replayed envelope is never labelled with a live policy version.
      const p = { ...deepClone(policy), version: `${policy.version ?? app.policy().version}+replay-${++counter}` };
      app.rememberPolicy(p);
      return { before: row.env, after: replayRow(row, p) };
    },
  };
}
