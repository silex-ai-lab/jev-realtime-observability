import { BATTERY } from '../engine/types.js';
import { esc, fmtPct } from '../ui/util.js';
import { createLearningSession } from './session.js';
import { loadEvidence } from './evidence.js';
const STAGES = ['Held for review', 'Reviewer answers', 'Labels', 'Train', 'Gate', 'Promote'];
const ACTION = { allow: 'No objection · would run', allow_and_alert: 'Would run + alert', hold_for_review: 'Held for review · would not run',
  hold_for_approval: 'Held for approval · would not run', deny: 'Blocked · would not run', stop_and_handover: 'Stop + handover · would not run' };
const verdict = e => `${ACTION[e.action] ?? e.action} — ${(e.reasons ?? []).join('; ') || 'No threshold crossed'}`;
function comparison(pairs) {
  const card = p => `<article class="learn-comparison" data-learn-pair="${esc(p.id)}" data-eligible="${p.eligible}" data-changed="${p.before.action !== p.after.action}">
    <h4>${esc(p.title)}</h4><span class="jv-meta">${p.control ? 'Hard control unchanged; a model cannot override it' : p.kind === 'attack' ? 'Authored attack variant' : p.kind === 'benign' ? 'Authored benign variant' : 'Session action · no authored truth'}${p.control && p.correctControl ? ' · correct against authored outcome' : ''}</span>
    <p class="learn-delta">v1 → v2${p.before.action !== p.after.action ? ' · outcome changed' : ' · unchanged'}</p><div class="cmp"><div data-before-action="${esc(p.before.action)}"><b>v1</b><p>${esc(verdict(p.before))}</p></div><div data-after-action="${esc(p.after.action)}"><b>v2 · simulated</b><p>${esc(verdict(p.after))}</p></div></div>
    <details><summary>Boolean scores and unchanged untrained answers</summary><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Question</th><th>v1</th><th>v2</th></tr></thead><tbody>${Object.entries(p.before.answers).map(([qid, a]) => {
      const b = p.after.answers[qid]; return `<tr><th>${esc(qid)}</th><td>${esc(a.type === 'noul' ? `p ${a.p} · risk ${a.risk}` : JSON.stringify(a.dist))}</td><td>${esc(b?.type === 'noul' ? `p ${b.p} · risk ${b.risk}` : JSON.stringify(b?.dist))}</td></tr>`;
    }).join('')}</tbody></table></div></details></article>`;
  const changed = pairs.filter(p => p.before.action !== p.after.action), unchanged = pairs.filter(p => p.before.action === p.after.action);
  return changed.map(card).join('') + (unchanged.length ? `<details data-learn-unchanged><summary>${unchanged.length} unchanged</summary>${unchanged.map(card).join('')}</details>` : '');
}
export function initLearning(app) {
  const root = document.querySelector('#learning-workflow'), evidenceRoot = document.querySelector('#learning-evidence');
  const session = createLearningSession(app.domain.id, app.policy, app.seed);
  let timer = null, evidence = null, presenter = null, presenterStage = null;
  // One cancellable timer owns presenter progress. A generation token rejects stale callbacks.
  let playGeneration = 0;
  function cancelPlay() { playGeneration++; clearTimeout(presenter); presenter = null; presenterStage = null; }
  function play() {
    cancelPlay(); clearTimeout(timer); session.reset();
    const generation = playGeneration;
    const steps = [() => session.load(), () => session.fillAuthored(), () => session.autoAnswer(),
      () => session.beginTrain(), () => { session.finishTrain(session.state().candidate?.id); session.gate(); }, () => session.promote()];
    function advance(i) {
      if (generation !== playGeneration) return;
      presenterStage = i; steps[i](); draw();
      presenter = setTimeout(() => { if (generation !== playGeneration) return; if (i + 1 < steps.length) advance(i + 1); else { presenter = null; presenterStage = null; draw(); } }, 1000);
    }
    advance(0);
  }
  function draw() {
    const focused = document.activeElement;
    let focusSelector = null;
    if (root.contains(focused)) {
      const example = focused.closest('[data-learn-example]');
      const attr = [...focused.attributes].find(a => a.name.startsWith('data-learn-'));
      if (attr) focusSelector = `${example ? `[data-learn-example="${CSS.escape(example.dataset.learnExample)}"] ` : ''}[${attr.name}="${CSS.escape(attr.value)}"]`;
    }
    const s = session.state(), c = s.candidate;
    const active = presenterStage ?? (s.phase === 'promoted' ? 5 : s.phase === 'gated' ? 4 : ['trained', 'training'].includes(s.phase) ? 3 : s.count >= s.N ? 2 : s.examples.length ? 1 : 0);
    const counts = [`${s.examples.length} actions`, `${s.drafts.length} answers`, `${s.labelCount} labels`, `${c ? Object.keys(c.snapshot.model.families).length : 0} families`, `${c?.gate ? c.gate.pairs.length : 0} variants`, c?.promoted ? 'promoted' : 'not yet'];
    const canTrain = s.count >= s.N && s.phase !== 'training';
    const canGate = c && s.phase !== 'training', canPromote = c?.gate?.pass && s.phase === 'gated';
    const disabled = [false, !s.examples.length, !s.labelCount, !canTrain, !canGate, !canPromote && !c?.promoted];
    const next = ['Load review examples', 'Answer and record labels', 'Train the simulated model', 'Run the held-out gate', 'Inspect gate results', 'Inspect the comparison'][active];
    const examples = s.examples.map(e => {
      const qs = BATTERY.filter(q => q.type === 'noul' && e.env.answers[q.id]);
      return `<article class="learn-example" data-learn-example="${esc(e.id)}"><h3>${esc(e.title)}</h3>
        <p class="jv-meta">${e.curriculum ? 'Authored teaching example · demo-author truth' : 'Held action from this Live session · answer manually'} · ${esc(e.env.decision)} by ${esc(e.env.decided_by)}</p>
        ${qs.map(q => { const d = s.drafts.find(d => d.example === e.id && d.qid === q.id), l = s.labels.find(l => l.example === e.id && l.qid === q.id);
          return `<label class="learn-answer">${esc(q.text)}<select data-learn-answer="${esc(q.id)}" aria-label="${esc(q.text)}"><option value="">Not answered</option><option value="true" ${d?.value === true ? 'selected' : ''}>Yes</option><option value="false" ${d?.value === false ? 'selected' : ''}>No</option></select></label>${l ? `<span class="chip sim" data-learn-label>${esc(q.id)}: ${l.value ? 'Yes' : 'No'} · ${esc(l.source)}</span>` : ''}`;
        }).join('')}
        <p class="jv-meta">${Object.entries(e.env.answers).filter(([, a]) => a.type !== 'noul').map(([qid, a]) => `${esc(qid)}: ${esc(JSON.stringify(a.dist))} · not trained in this demo`).join('<br>')}</p>
        <div class="learn-actions"><button class="btn" data-learn-submit="Allow">Allow · record labels</button><button class="btn" data-learn-submit="Deny">Deny · record labels</button></div>
        <small>Records answered questions only. Never releases or executes the held tool call.</small></article>`;
    }).join('');
    const g = c?.gate;
    const outcome = g ? `After ${c.snapshot.labels.length} reviewer answers, simulated on ${g.pairs.length} unseen authored actions: missed attacks ${g.before.missed}/${g.before.attacks} → ${g.after.missed}/${g.after.attacks} · sent to a person ${g.before.review}/${g.before.total} → ${g.after.review}/${g.after.total} · false holds ${g.before.falseHolds}/${g.before.benign} → ${g.after.falseHolds}/${g.after.benign}` : 'Answer the review examples to see what changes';
    const residual = g?.pairs.filter(p => p.eligible && (p.kind === 'attack' ? p.after.action === 'allow' : p.after.action !== 'allow')).length;

    const tiles = g ? [
      ['Missed attacks', 'missedRate', 'missed', 'attacks'], ['Reviewer load', 'reviewRate', 'review', 'total'], ['False holds', 'falseHoldRate', 'falseHolds', 'benign'],
    ].map(([title, rate, n, d]) => `<div class="jv-kpi"><div class="k">${title} · simulated</div><div class="v">${fmtPct(g.before[rate])} → ${fmtPct(g.after[rate])}</div>${['before', 'after'].map((side, i) => `<div class="learn-bar-row"><span>v${i + 1}</span><div class="learn-bar-track"><div class="learn-bar ${side}" style="width:${Math.max(0, Math.min(100, (g[side][rate] ?? 0) * 100))}%"></div></div><span>${g[side][n]}/${g[side][d]}</span></div>`).join('')}<div class="s">${g.before[n]}/${g.before[d]} → ${g.after[n]}/${g.after[d]} · eligible held-out variants only</div></div>`).join('') : '';
    root.innerHTML = `<section class="learn-outcome" aria-label="Simulated outcome"><p data-learn-outcome>${esc(outcome)}</p>${g ? `<p class="jv-meta" data-learn-residual>${residual} eligible held-out ${residual === 1 ? "outcome is" : "outcomes are"} still wrong under v2. Improvement is not perfect detection; these authored examples are not benchmark estimates. Hard controls are excluded from the fractions.</p>` : ''}<button class="btn primary" data-learn-play ${presenterStage != null ? 'disabled' : ''}>${presenterStage != null ? 'Playing the authored loop…' : 'Play the loop'}</button><small>Scripted demo-author answers, not independent human review. Starts a fresh learning session.</small></section><div class="learn-current"><div><span class="chip sim">SIMULATED WORKFLOW</span><h2>${STAGES[active]}</h2><p>${next}</p></div><button class="btn" data-learn-reset>Reset learning session</button></div>
      <nav class="learn-stages" aria-label="Learning workflow">${STAGES.map((title, i) => `<button type="button" data-learn-stage="${i}" ${disabled[i] || presenterStage != null ? 'disabled' : ''} ${active === i ? 'aria-current="step"' : ''} title="${disabled[i] ? `Complete the preceding stage; ${Math.max(0, s.N - s.count)} curriculum answers remain` : title}"><b>${i + 1}. ${title}</b><span>${counts[i]}</span></button>`).join('')}</nav>
      <p role="status" data-learn-status>${esc(s.status)}</p>
      <section id="learn-review"><h2>Review inbox <span class="chip sim">simulated</span></h2><p>Teach the Boolean questions. Scripted filling uses demo-author truth; it is not independent human review. Switching agents reloads and resets learning and Policy Studio edits.</p>
        <div class="learn-actions"><button class="btn primary" data-learn-load>Load review examples</button><button class="btn" data-learn-auto ${s.examples.some(e => e.truth) ? '' : 'disabled'}>Fill remaining authored answers and record labels</button></div>
        <p data-learn-count><b>${s.count} of ${s.N}</b> curriculum Boolean labels recorded · ${s.labelCount} total labels. Re-answering replaces a label.</p>
        <details ${s.examples.length && s.count < s.N ? 'open' : ''}><summary>${s.examples.length} review examples and session holds</summary><div class="learn-inbox">${examples || '<p>No held actions yet. Load examples to start without running Live.</p>'}</div></details></section>
      <div class="learn-two"><section class="card pad" id="learn-train"><h2>Train the toy model</h2><p>A feature-based logistic correction illustrates learning from labels. No Kev model, LoRA or RL is run in this browser.</p>
        <label><input type="checkbox" data-learn-failed ${s.failed ? 'checked' : ''}> Show a failed retrain</label><p class="jv-meta">Flips submitted labels for ${esc(s.failedFamily)} only: a mislabelled toy batch, not a reproduction of the Kev-4B experiment.</p>
        <button class="btn primary" data-learn-train ${canTrain ? '' : 'disabled'}>${s.phase === 'training' ? 'Fitting simulated correction…' : 'Train simulated v2'}</button>
        ${s.phase === 'training' ? '<progress aria-label="Simulated training animation"></progress>' : ''}
        ${c ? `<div data-learn-model><h3>v2 · simulated logistic correction</h3><p>${c.snapshot.labels.length} frozen labels · ${Object.keys(c.snapshot.model.families).length} Boolean families · ${c.snapshot.model.training.steps} fixed gradient steps · learning rate ${c.snapshot.model.training.rate} · L2 ${c.snapshot.model.training.l2}.</p><p>Animation duration is illustrative. Measured LoRA wall time and its much larger batch appear separately below.</p><p>Frozen policy ${esc(c.snapshot.policy.version)} · seed ${esc(c.snapshot.seed)} · fault ${esc(c.snapshot.fault ?? 'none')}.</p></div>` : ''}</section>
      <section class="card pad" id="learn-gate"><h2>Gate on unseen authored variants</h2><p>Same frozen policy and thresholds. Pass requires missed attacks and false holds not to increase, and at least one to decrease. Empty classes or monitor/fault variants are inconclusive. Hard controls are outside the metrics.</p>
        <button class="btn" data-learn-gate ${canGate ? '' : 'disabled'}>Run held-out gate</button>
        ${g ? `<p class="note ${g.pass ? 'info' : 'warn'}" data-learn-gate-result data-pass="${g.pass}">${esc(g.reason)}</p>` : ''}
        <button class="btn primary" data-learn-promote ${canPromote ? '' : 'disabled'}>Promote inside this comparison</button><p>Proposed promotion gate: production promotion is not implemented. Live remains v1.</p></section></div>
      ${g ? `<section id="learn-comparison"><h2>Before and after · simulated held-out set</h2><div class="jv-kpis learn-tiles">${tiles}</div><p>Missed attacks count allowed attack actions. Reviewer load counts hold_for_review. False holds count benign actions held or denied. Successful pre_tool semantic actions include ALLOW by policy; rule/fallback outcomes are excluded.</p><div>${comparison(g.pairs)}</div></section>` : ''}
      ${c?.promoted ? `<section><h2>Your teaching examples and session actions under v2</h2><p>Counterfactual simulated replay only. Existing Live decisions and gateway execution do not change.</p>${comparison(c.sessionPairs)}</section>` : ''}`;
    if (presenterStage != null) root.querySelectorAll('button:not([data-learn-reset]), select, input').forEach(control => { control.disabled = true; });
    if (focusSelector) root.querySelector(focusSelector)?.focus({ preventScroll: true });
  }
  root.addEventListener('change', e => {
    const select = e.target.closest('[data-learn-answer]');
    if (select) { cancelPlay(); clearTimeout(timer); if (select.value === '') session.clearAnswer(select.closest('[data-learn-example]').dataset.learnExample, select.dataset.learnAnswer); else session.answer(select.closest('[data-learn-example]').dataset.learnExample, select.dataset.learnAnswer, select.value === 'true'); draw(); }
    if (e.target.matches('[data-learn-failed]')) { cancelPlay(); clearTimeout(timer); session.failed(e.target.checked); draw(); }
  });
  root.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    if (b.matches('[data-learn-play]')) { play(); return; }
    if (!b.matches('[data-learn-stage]')) cancelPlay();
    if (b.matches('[data-learn-load]')) session.load();
    if (b.matches('[data-learn-auto]')) session.autoAnswer();
    if (b.matches('[data-learn-submit]')) session.submit(b.closest('[data-learn-example]').dataset.learnExample, b.dataset.learnSubmit);
    if (b.matches('[data-learn-reset]')) { clearTimeout(timer); session.reset(); }
    if (b.matches('[data-learn-train]')) { clearTimeout(timer); const id = session.beginTrain(); if (id != null) timer = setTimeout(() => { session.finishTrain(id); draw(); }, 500); }
    if (b.matches('[data-learn-gate]')) session.gate();
    if (b.matches('[data-learn-promote]')) session.promote();
    if (b.matches('[data-learn-stage]')) { const stage = Number(b.dataset.learnStage); document.querySelector(stage < 3 ? '#learn-review' : stage === 3 ? '#learn-train' : stage === 4 ? '#learn-gate' : '#learn-comparison')?.scrollIntoView({ block: 'start' }); return; }
    draw();
  });
  draw(); loadEvidence(evidenceRoot).then(data => { evidence = data; });
  return { onShow: draw, onRow(row, history) { const added = session.addLive(row, history); if (added && !document.querySelector('[data-panel=learning]').hidden && !root.contains(document.activeElement)) draw(); },
    onPolicy() { cancelPlay(); clearTimeout(timer); session.policyChanged(); draw(); }, onFault(value) { cancelPlay(); clearTimeout(timer); session.setFault(value); draw(); },
    state: session.state, evidence: () => evidence };
}
