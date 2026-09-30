// Policy Studio: the live policy as code. Each valid edit applies at once as a
// new version; invalid bands are rejected and the control snaps back.

import { BATTERY, DEFAULT_POLICY } from '../engine/types.js';
import { validatePolicy } from '../engine/policy.js';
import { DOMAINS, SHARED_RULES } from '../engine/domains.js';
import { $, esc, chip, deepClone } from './util.js';

const usedBy = qid => ['ap', 'soc'].filter(d => DOMAINS[d].questions.includes(qid)).map(d => chip(d.toUpperCase(), 'b')).join(' ');

function diff(a, b, path = '') {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return a === b ? [] : [`${path}: <span class="diff-del">${esc(JSON.stringify(a))}</span> → <span class="diff-add">${esc(JSON.stringify(b))}</span>`];
  }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => k !== 'version');
  return keys.flatMap(k => diff(a[k], b[k], path ? `${path}.${k}` : k));
}

export function initStudio(app) {
  // Only the chosen agent's questions, tools and rules (the shared rules too); the policy object itself holds both agents.
  const NOUL = BATTERY.filter(q => q.type === 'noul' && app.domain.questions.includes(q.id)).map(q => q.id);
  const RULES = [...app.domain.rules, ...SHARED_RULES];
  const thr = $('#studio-thr'), tools = $('#studio-tools'), err = $('#studio-err'), ver = $('#studio-version'), dff = $('#studio-diff');
  let n = 1;

  function apply(mutate) {
    const next = deepClone(app.policy());
    mutate(next);
    const v = validatePolicy(next);
    if (!v.ok) { err.textContent = `Rejected: ${v.errors.join('; ')}`; draw(); return false; }
    next.version = `policy-v${++n}`;
    err.textContent = '';
    app.setPolicy(next);
    draw();
    return true;
  }

  function draw() {
    const p = app.policy();
    ver.textContent = p.version;
    thr.innerHTML = NOUL.map(q => ['review_threshold', 'block_threshold'].map(k => {
      const v = p.thresholds[q][k];
      return `<label for="st-${q}-${k}">${esc(q)} · ${k.replace('_threshold', '')}</label>
        <input type="range" min="0" max="1" step="0.01" id="st-${q}-${k}" data-studio-threshold="${q}.${k}" value="${v}">
        <output>${v.toFixed(2)}</output>`;
    }).join('')).join('');
    tools.innerHTML = `<tr><th>Tool</th><th>Mode</th><th>On judge failure</th></tr>` +
      Object.entries(p.tools).filter(([t]) => t in app.domain.tools).map(([t, c]) => `<tr><td class="mono">${esc(t)}</td>
        <td><select class="btn" data-tool-mode="${esc(t)}" aria-label="${esc(t)} mode">
          <option value="gate" ${c.mode === 'gate' ? 'selected' : ''}>Gate (enforce)</option>
          <option value="monitor" ${c.mode === 'monitor' ? 'selected' : ''}>Monitor (shadow)</option></select></td>
        <td><select class="btn" data-tool-fail="${esc(t)}" aria-label="${esc(t)} failure mode">
          <option value="closed" ${c.fail === 'closed' ? 'selected' : ''}>fail closed</option>
          <option value="open" ${c.fail === 'open' ? 'selected' : ''}>fail open + alert</option></select></td></tr>`).join('');
    const d = diff(DEFAULT_POLICY, p);
    dff.innerHTML = d.length ? d.join('<br>') : 'No changes.';
  }

  // Four columns fit the half-width card; where a question is asked and what it reads sit under the question.
  $('#studio-battery').innerHTML = `<tr><th>id</th><th>type</th><th>question</th><th>used by</th></tr>` +
    BATTERY.map(q => `<tr data-question="${esc(q.id)}"><td class="mono">${esc(q.id)}${q.p0 ? ' ' + chip('P0', 'b') : ''}</td><td>${esc(q.type)}${q.risk === '1-p' ? ' (risk 1−p)' : ''}</td>
      <td>${esc(q.text)}<div class="jv-meta q-meta">at <span class="mono">${esc(q.boundaries.join(', '))}</span> · reads <span class="mono">${esc(q.features.join(', '))}</span></div></td>
      <td class="nowrap">${usedBy(q.id)}</td></tr>`).join('');
  $('#studio-rules').innerHTML = `<tr><th>rule</th><th>verdict</th><th>where</th><th>condition</th></tr>` +
    RULES.map(r => `<tr data-rule="${esc(r[0])}"><td class="mono">${r[0]}</td><td>${chip(r[1], r[1])}</td><td>${esc(r[2])}</td><td>${esc(r[3])}</td></tr>`).join('');

  thr.addEventListener('input', e => {
    const t = e.target.closest('[data-studio-threshold]'); if (t) t.nextElementSibling.textContent = Number(t.value).toFixed(2);
  });
  thr.addEventListener('change', e => {
    const t = e.target.closest('[data-studio-threshold]'); if (!t) return;
    const [q, k] = t.dataset.studioThreshold.split('.');
    apply(p => { p.thresholds[q][k] = Number(t.value); });
  });
  tools.addEventListener('change', e => {
    const m = e.target.closest('[data-tool-mode]'), f = e.target.closest('[data-tool-fail]');
    if (m) apply(p => { p.tools[m.dataset.toolMode].mode = m.value; });
    if (f) apply(p => { p.tools[f.dataset.toolFail].fail = f.value; });
  });
  $('#studio-revert').addEventListener('click', () => { app.setPolicy(deepClone(DEFAULT_POLICY)); draw(); err.textContent = ''; });

  draw();
  return { draw };
}
