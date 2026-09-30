// What-if (logs/2026-09-30_CONSOLE_UX_PLAN.md, r7 C3'): which recorded actions cross the semantic thresholds you set.
// It runs POST /v1/replays policy_only over the recorded original decisions: zero judge calls, the stored signals only.
// In this build semantic checks are uncalibrated, so a threshold only flags; it never holds or blocks. Whether a flag is
// right is for a person to judge.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ESC[c]);
export const WHATIF_NOTE = 'What-if flags only. In this build semantic checks are uncalibrated, so a threshold marks an action but never holds or blocks it. Enforcing it needs a calibration, which does not exist yet. Whether a flag is right is for a person to judge.';
export const WHATIF_AUDIT = 'Replay decisions are recorded for audit; live decisions are unchanged.';
const FLAG = new Set(['experimental_review', 'review']);
const flagged = hits => (hits ?? []).filter(h => FLAG.has(h.band));

/** deps: { api(path, opts), policy(): active policy body, runIds(): string[], titles(): {scenario → title} } */
export function createWhatIf(deps) {
  const panel = document.querySelector('#whatif');
  if (!panel) return null;
  const body = panel.querySelector('.whatif-body');

  function open() {
    const pol = deps.policy();
    const bands = Object.entries(pol?.semantic?.bands ?? {});
    body.innerHTML = `<p class="whatif-note" data-whatif-note>${esc(WHATIF_NOTE)}</p>
      <div class="whatif-bands">${bands.map(([q, b]) => `<label class="wb"><span class="mono">${esc(q)}</span>
        <input type="range" min="0" max="1" step="0.01" value="${b.review_at}" data-band="${esc(q)}"><output>${Number(b.review_at).toFixed(2)}</output></label>`).join('')}</div>
      <p><button type="button" class="btn primary" data-whatif-run>Run what-if on recorded runs</button> <span class="lv-meta">0 judge calls: it reuses the stored signals</span></p>
      <div class="whatif-out"></div>`;
    panel.hidden = false; document.body.classList.add('drawer-open');
  }
  function close() { panel.hidden = true; document.body.classList.remove('drawer-open'); }

  async function run() {
    const out = body.querySelector('.whatif-out');
    out.innerHTML = '<p class="lv-meta">Replaying recorded decisions…</p>';
    if (!deps.policy()?.semantic?.bands) { out.innerHTML = '<p class="lv-meta">No active policy loaded yet. Connect first.</p>'; return; }
    const policy = structuredClone(deps.policy());
    for (const el of body.querySelectorAll('[data-band]')) policy.semantic.bands[el.dataset.band].review_at = Number(el.value);
    policy.policy_version = `${policy.policy_version}+whatif`;
    // The recorded original decisions (never replay decisions) that have semantic signals, newest runs first.
    const items = [];
    for (const runId of deps.runIds()) {
      if (items.length >= 500) break;
      let d; try { d = await deps.api(`/v1/runs/${encodeURIComponent(runId)}`); } catch { continue; }
      const started = (d.timeline ?? []).find(t => t.event?.boundary === 'run_started');
      const scenario = started?.event?.attributes?.scenario ?? null;
      for (const t of d.timeline ?? []) {
        if (!['pre_tool', 'post_generation', 'pre_input'].includes(t.event?.boundary)) continue;
        const orig = (t.decisions ?? []).filter(x => !x.replay_of).at(-1);
        if (!orig || !(orig.semantic?.hits ?? []).length) continue;
        items.push({ runId, scenario, eventId: t.event.event_id, decisionId: orig.decision_id, today: flagged(orig.semantic.hits),
          label: t.event.operation?.tool ?? (t.event.boundary === 'post_generation' ? 'agent statement' : 'input read'), arg: t.event.operation?.args ?? null });
        if (items.length >= 500) break;
      }
    }
    if (!items.length) { out.innerHTML = '<p class="lv-meta">No recorded decision has judge signals yet. Run a scenario first.</p>'; return; }
    let r;
    try { r = await deps.api('/v1/replays', { method: 'POST', body: { kind: 'policy_only', decision_ids: items.map(x => x.decisionId), policy } }); }
    catch (e) { out.innerHTML = `<p class="note bad">What-if failed: ${esc(e.message)}</p>`; return; }
    const after = Object.fromEntries((r.results ?? []).map(x => [x.decision_id, x]));
    const titles = deps.titles();
    const byRun = new Map();
    let nFlag = 0; const runsHit = new Set();
    for (const it of items) {
      const res = after[it.decisionId];
      const now = res?.after ? flagged(res.after.semantic?.hits) : [];
      if (now.length) { nFlag++; runsHit.add(it.runId); }
      (byRun.get(it.runId) ?? byRun.set(it.runId, { scenario: it.scenario, rows: [] }).get(it.runId)).rows.push({ ...it, now, error: res?.error });
    }
    const fmt = hs => hs.length ? hs.map(h => `<span data-question="${esc(h.question_id)}" data-value="${esc(h.value)}">${esc(h.question_id)} ${Number(h.value).toFixed(2)}</span>`).join(', ') : '<span class="lv-meta">not flagged</span>';
    const key = a => { if (!a) return ''; const k = ['ip', 'user_id', 'ticket_id', 'invoice_id', 'url', 'to'].find(x => a[x] != null); return k ? String(a[k]) : ''; };
    out.innerHTML = `<p class="whatif-summary" data-whatif-summary><b>${nFlag}</b> action${nFlag === 1 ? '' : 's'} would be flagged · <b>${runsHit.size}</b> run${runsHit.size === 1 ? '' : 's'} affected · <b>${esc(r.judge_calls ?? 0)}</b> judge calls</p>
      <p class="lv-meta">${esc(WHATIF_AUDIT)}</p>
      ${[...byRun.entries()].sort((x, y) => y[1].rows.filter(r => r.now.length).length - x[1].rows.filter(r => r.now.length).length).map(([runId, g]) => {
        const row = x => `<tr class="whatif-row" data-flagged="${x.now.length > 0}" data-event-id="${esc(x.eventId)}"><td><b class="mono">${esc(x.label)}</b> <span class="lv-meta mono">${esc(key(x.arg))}</span></td>
          <td>${fmt(x.today)}</td><td>${x.error ? `<span class="lv-meta">error: ${esc(x.error)}</span>` : fmt(x.now)}</td></tr>`;
        const hit = g.rows.filter(x => x.now.length), rest = g.rows.filter(x => !x.now.length);
        // Flagged steps first; the others stay one click away (they are still part of the result).
        return `<div class="whatif-run" data-flagged-count="${hit.length}"><div class="whatif-run-h"><span class="id-pill">${esc(g.scenario ?? 'run')}</span> ${esc(titles[g.scenario] ?? runId)}
          <span class="lv-meta">${hit.length ? `${hit.length} flagged` : 'nothing flagged'}</span></div>
          <table class="whatif-tbl"><thead><tr><th>Step</th><th>Today</th><th>With these thresholds</th></tr></thead><tbody>${hit.map(row).join('')}</tbody></table>
          ${rest.length ? `<details class="whatif-rest"><summary>${rest.length} step${rest.length === 1 ? '' : 's'} not flagged</summary><table class="whatif-tbl"><tbody>${rest.map(row).join('')}</tbody></table></details>` : ''}</div>`;
      }).join('')}`;
  }

  panel.addEventListener('click', e => {
    if (e.target.closest?.('[data-whatif-run]')) run();
    if (e.target.closest?.('[data-whatif-close]')) close();
  });
  panel.addEventListener('input', e => { const t = e.target.closest?.('[data-band]'); if (t) t.nextElementSibling.textContent = Number(t.value).toFixed(2); });
  return { open, close };
}
