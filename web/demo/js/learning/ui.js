import { BATTERY } from '../engine/types.js';
import { esc, fmtPct } from '../ui/util.js';
import { createLearningSession } from './session.js';
import { loadEvidence } from './evidence.js';
const STAGES = ['Review', 'Labels', 'Train', 'Gate', 'Promote'];
const ACTION = { allow: 'No objection · would run', allow_and_alert: 'Would run + alert', hold_for_review: 'Held for review · would not run',
  hold_for_approval: 'Held for approval · would not run', deny: 'Blocked · would not run', stop_and_handover: 'Stop + handover · would not run' };
const verdict = e => `${ACTION[e.action] ?? e.action} — ${(e.reasons ?? []).join('; ') || 'No threshold crossed'}`;
function comparison(pairs, championLabel = 'v2') {
  const card = p => `<article class="learn-comparison" data-learn-pair="${esc(p.id)}" data-eligible="${p.eligible}" data-changed="${p.before.action !== p.after.action}">
    <h4>${esc(p.title)}</h4><span class="jv-meta">${p.control ? 'Hard control unchanged; a model cannot override it' : p.kind === 'attack' ? 'Authored attack variant' : p.kind === 'benign' ? 'Authored benign variant' : 'Session action · no authored truth'}${p.control && p.correctControl ? ' · correct against authored outcome' : ''}</span>
    <p class="learn-delta">v1 → ${esc(championLabel)}${p.before.action !== p.after.action ? ' · outcome changed' : ' · unchanged'}</p><div class="cmp"><div data-before-action="${esc(p.before.action)}"><b>v1</b><p>${esc(verdict(p.before))}</p></div><div data-after-action="${esc(p.after.action)}"><b>${esc(championLabel)} · simulated</b><p>${esc(verdict(p.after))}</p></div></div>
    <details><summary>Boolean scores and unchanged untrained answers</summary><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Question</th><th>v1</th><th>v2</th></tr></thead><tbody>${Object.entries(p.before.answers).map(([qid, a]) => {
      const b = p.after.answers[qid]; return `<tr><th>${esc(qid)}</th><td>${esc(a.type === 'noul' ? `p ${a.p} · risk ${a.risk}` : JSON.stringify(a.dist))}</td><td>${esc(b?.type === 'noul' ? `p ${b.p} · risk ${b.risk}` : JSON.stringify(b?.dist))}</td></tr>`;
    }).join('')}</tbody></table></div></details></article>`;
  const changed = pairs.filter(p => p.before.action !== p.after.action), unchanged = pairs.filter(p => p.before.action === p.after.action);
  return changed.map(card).join('') + (unchanged.length ? `<details data-learn-unchanged><summary>${unchanged.length} unchanged</summary>${unchanged.map(card).join('')}</details>` : '');
}
export function initLearning(app) {
  const root = document.querySelector('#learning-workflow'), evidenceRoot = document.querySelector('#learning-evidence');
  const session = createLearningSession(app.domain.id, app.policy, app.seed);
  let timer = null, evidence = null, presenter = null, presenterStage = null, playGeneration = 0, manualOpen = false;
  function cancelPlay() { playGeneration++; clearTimeout(presenter); presenter = null; presenterStage = null; }
  function play() {
    cancelPlay(); clearTimeout(timer); session.startScript(); manualOpen = false;
    const generation = playGeneration;
    function advance(i) {
      if (generation !== playGeneration) return;
      presenterStage = i % STAGES.length;
      if (presenterStage === 3) session.scriptRound(Math.floor(i / STAGES.length) + 1);
      draw();
      presenter = setTimeout(() => {
        if (generation !== playGeneration) return;
        if (i < 14) advance(i + 1); else { presenter = null; presenterStage = null; draw(); }
      }, 350);
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
    const canTrain = s.count >= s.N && s.phase !== 'training', canGate = c && s.phase === 'trained';
    const examples = s.examples.filter(e => !s.quarantine.includes(e.id)).map(e => {
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
    const selected = s.history.find(r => r.id === s.selected);
    const decision = selected?.gate;
    const g = s.payoff;
    const outcome = g ? `v1 → ${s.champion.id}: missed attacks ${g.before.missed}/${g.before.attacks} → ${g.after.missed}/${g.after.attacks} · sent to a person ${g.before.review}/${g.before.total} → ${g.after.review}/${g.after.total} · false holds ${g.before.falseHolds}/${g.before.benign} → ${g.after.falseHolds}/${g.after.benign}` : 'v1 is active. Play the loop to see three gate decisions.';
    const reason = d => !d.valid ? 'Invalid evaluation' : !d.safetyOk ? 'Safety regression' : d.reason === 'a control changed' ? 'A control changed; champion stays' : d.verdict === 'KEEP' ? 'Enough evidence to promote' : d.verdict === 'NEAR-MISS' ? 'Needs more examples; champion stays' : 'Not better; champion stays';
    const evidenceLine = d => d.evidenceOk ? 'Evidence: enough' : d.fixed > d.broke ? 'Evidence: needs more examples' : `Evidence: no improvement (fixed ${d.fixed} ≤ broke ${d.broke})`;
    const node = (id, title, text, active, labels, kind = '') => `<button class="learn-node ${esc(kind)}" data-learn-node="${esc(id)}" aria-pressed="${s.selected === id}"><b>${esc(title)}</b><span>${esc(text)}</span>${labels == null ? '' : `<small>${labels} labels</small>`}${active ? '<span class="learn-active" data-learn-active>ACTIVE</span>' : ''}</button>`;
    const tiles = g ? [
      ['Missed attacks', 'missedRate', 'missed', 'attacks'], ['Reviewer load', 'reviewRate', 'review', 'total'], ['False holds', 'falseHoldRate', 'falseHolds', 'benign'],
    ].map(([title, rate, n, d]) => `<div class="jv-kpi"><div class="k">${title} · simulated</div><div class="v">${fmtPct(g.before[rate])} → ${fmtPct(g.after[rate])}</div>${['before', 'after'].map((side, i) => `<div class="learn-bar-row"><span>${i === 0 ? 'v1' : esc(s.champion.id)}</span><div class="learn-bar-track"><div class="learn-bar ${side}" style="width:${Math.max(0, Math.min(100, (g[side][rate] ?? 0) * 100))}%"></div></div><span>${g[side][n]}/${g[side][d]}</span></div>`).join('')}<div class="s">${g.before[n]}/${g.before[d]} → ${g.after[n]}/${g.after[d]} · eligible held-out variants only</div></div>`).join('') : '';
    root.innerHTML = `<div class="learn-actions"><button class="btn primary" data-learn-play ${presenterStage != null ? 'disabled' : ''}>${presenterStage != null ? 'Playing…' : 'Play the loop'}</button><button class="btn" data-learn-reset>Reset</button></div>
      <p class="jv-meta">Rounds are a scripted exercise chosen with knowledge of the outcomes to show each gate outcome. Play uses the default policy, seed 7 and no fault. Scripted demo-author answers, not independent human review.</p>
      <nav class="learn-stages" aria-label="Learning workflow">${STAGES.map((title, i) => `<span ${presenterStage === i ? 'aria-current="step"' : ''}>${title}</span>`).join('<span aria-hidden="true">→</span>')}</nav>
      <h2>Model history</h2><div class="learn-history" aria-label="Model history">${node('v1', 'v1 · released', 'Starting model', s.champion.id === 'v1', null)}${s.history.map((r, i) => node(r.id, `Round ${i + 1}${r.promotedTo ? ` · ${r.promotedTo}` : ''}`, `${r.gate.verdict} · ${reason(r.gate)}`, r.promotedTo === s.champion.id, r.snapshot.labels.length, r.gate.verdict.toLowerCase())).join('')}</div>
      <section class="learn-outcome" id="learn-gate" aria-label="Selected gate decision">${decision ? `<h2 data-learn-gate-result data-pass="${decision.pass}">${esc(decision.verdict)} · ${esc(reason(decision))}</h2>
        <p data-gate-safety>Safety: ${decision.valid ? decision.safetyOk ? 'no rise in missed attacks or false holds ✓' : 'missed attacks or false holds rose ✗' : 'invalid evaluation ✗'}<small>Missed attacks ${decision.before.missed}/${decision.before.attacks} → ${decision.after.missed}/${decision.after.attacks} · False holds ${decision.before.falseHolds}/${decision.before.benign} → ${decision.after.falseHolds}/${decision.after.benign}</small></p>
        <p data-gate-counts>Fixed ${decision.fixed} · Broke ${decision.broke}</p><p data-gate-evidence>${esc(evidenceLine(decision))}</p>
        <p>${decision.pass ? `${esc(selected.promotedTo)} replaced ${esc(selected.championBefore)} inside this comparison.` : `${esc(selected.championBefore)} stayed active after this attempt.`} ${!decision.valid ? esc(decision.reason) : ''}</p>
        <details><summary>How the evidence check works</summary><p>One-sided paired test p = ${esc(decision.p)}; α = 0.05, fixed before runs. Assuming a change is as likely to fix an item as to break it, this is the probability of at least this many fixes among the items that changed. KEEP means this test passed, not that improvement or safety is proved. NEAR-MISS means not enough evidence, not that versions are equal. Safety compares aggregate counts; individual breaks remain visible.</p></details>` : `<p>${s.history.length ? 'Select an attempt to inspect its decision.' : 'Press Play the loop to see three gate decisions.'}</p>`}
        ${s.history.length ? '<p class="jv-meta">Illustrative: a few authored, partly repeated examples; not a calibrated error rate, and the rounds reuse one test set. Repeated testing does not give a session-wide 5% false-promotion guarantee.</p>' : ''}</section>
      ${g ? `<section id="learn-comparison"><h2>Before and after · v1 → ${esc(s.champion.id)}</h2><p data-learn-outcome>${esc(outcome)}</p><div class="jv-kpis learn-tiles">${tiles}</div><p data-learn-residual>${g.pairs.filter(p => p.eligible && (p.kind === 'attack' ? p.after.action === 'allow' : p.after.action !== 'allow')).length} outcomes still wrong. Simulated authored actions, not benchmark estimates. Hard controls are excluded.</p><details><summary>Action comparisons</summary>${comparison(g.pairs, s.champion.id)}</details></section>` : ''}
      <details data-learn-manual ${manualOpen ? 'open' : ''}><summary>Do it yourself</summary>${s.phase === 'gated' ? '' : `<p role="status" data-learn-status>${esc(s.status)}</p>`}<p>A simulated feature-based logistic correction, not Kev weights, LoRA or RL. Each candidate is refitted from released v1 scores. Promotion affects only this Learning comparison; Live stays v1.</p>
      <section id="learn-review"><h2>Review inbox</h2><p>Switching agents reloads and resets learning. Allow/Deny records labels only; never releases a tool call.</p><div class="learn-actions"><button class="btn" data-learn-load>Load review examples</button><button class="btn" data-learn-auto ${s.examples.some(e => e.truth) ? '' : 'disabled'}>Fill remaining authored answers and record labels</button></div><p data-learn-count>${s.count} of ${s.N} curriculum Boolean labels recorded · ${s.labelCount} total labels. Re-answering replaces a label.</p><div class="learn-inbox">${examples || '<p>No review examples loaded.</p>'}</div></section>
      <section id="learn-train"><h2>Train and test</h2><button class="btn" data-learn-careless ${s.count < s.N || s.examples.some(e => e.careless) ? 'disabled' : ''}>Add a careless reviewer batch</button><p>Two new authored examples with wrong labels on ${app.domain.id === 'ap' ? 'payee_mismatch' : 'goal_deviation'}. Discarded careless labels are set aside for re-review and excluded from later training.</p>${s.quarantine.length ? `<p data-learn-quarantine>${s.quarantine.length} authored examples set aside. Re-review is a simulated status.</p>` : ''}
        <button class="btn primary" data-learn-train ${canTrain ? '' : 'disabled'}>${s.phase === 'training' ? 'Fitting…' : 'Train simulated candidate'}</button><button class="btn" data-learn-gate ${canGate ? '' : 'disabled'}>Run held-out gate</button>
        ${c ? `<p data-learn-model>Simulated logistic correction · ${c.snapshot.labels.length} frozen labels · ${c.snapshot.model.training.steps} fixed gradient steps · rate ${c.snapshot.model.training.rate} · L2 ${c.snapshot.model.training.l2}. Policy ${esc(c.snapshot.policy.version)} · seed ${c.snapshot.seed} · fault ${esc(c.snapshot.fault ?? 'none')}. Animation time is illustrative.</p>` : ''}</section></details>`;
    root.querySelector('[data-learn-manual]').addEventListener('toggle', e => { manualOpen = e.target.open; });
    if (presenterStage != null) root.querySelectorAll('button:not([data-learn-reset]), select, input').forEach(control => { control.disabled = true; });
    if (focusSelector) root.querySelector(focusSelector)?.focus({ preventScroll: true });
  }
  root.addEventListener('change', e => {
    const select = e.target.closest('[data-learn-answer]');
    if (!select) return;
    cancelPlay(); clearTimeout(timer);
    const id = select.closest('[data-learn-example]').dataset.learnExample;
    if (select.value === '') session.clearAnswer(id, select.dataset.learnAnswer); else session.answer(id, select.dataset.learnAnswer, select.value === 'true'); draw();
  });
  root.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    if (b.matches('[data-learn-play]')) { play(); return; }
    cancelPlay();
    if (b.matches('[data-learn-node]')) session.select(b.dataset.learnNode);
    if (b.matches('[data-learn-load]')) session.load();
    if (b.matches('[data-learn-auto]')) session.autoAnswer();
    if (b.matches('[data-learn-careless]')) session.addCareless();
    if (b.matches('[data-learn-submit]')) session.submit(b.closest('[data-learn-example]').dataset.learnExample, b.dataset.learnSubmit);
    if (b.matches('[data-learn-reset]')) { clearTimeout(timer); session.reset(); manualOpen = false; }
    if (b.matches('[data-learn-train]')) { clearTimeout(timer); const id = session.beginTrain(); if (id != null) timer = setTimeout(() => { session.finishTrain(id); draw(); }, 500); }
    if (b.matches('[data-learn-gate]')) session.gate();
    draw();
  });
  draw(); loadEvidence(evidenceRoot).then(data => { evidence = data; });
  return { onShow: draw, onRow(row, history) { const added = session.addLive(row, history); if (added && !document.querySelector('[data-panel=learning]').hidden && !root.contains(document.activeElement)) draw(); },
    onPolicy() { cancelPlay(); clearTimeout(timer); session.policyChanged(); draw(); }, onFault(value) { cancelPlay(); clearTimeout(timer); session.setFault(value); draw(); },
    state: session.state, evidence: () => evidence };
}
