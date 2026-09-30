// Re-check and Run again on a run card (logs/2026-09-30_CONSOLE_UX_PLAN.md, r7 C2').
// Re-check re-assesses the run's recorded actions with the current judge and policy (POST /v1/replays model_reeval):
// real model calls, counted from the API's own judge_calls; it does not run a changed agent. Run again starts the same
// scripted scenario as a new run (POST /v1/sandbox/reexec); its allowed sandbox writes happen again.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ESC[c]);
const WORD = { NO_CONFIGURED_RISK: 'No objection', ALERT: 'Flagged', HOLD: 'Held', REVIEW: 'Held for review', UNKNOWN: 'Held for review', BLOCK: 'Blocked', STOP: 'Blocked', REJECT: 'Blocked' };
const word = r => WORD[r] ?? r ?? '—';
const SKIP = { no_judge_questions_for_this_decision: 'skipped: this step asked the judge nothing (decided by rules or nothing to ask)', not_found: 'error: decision not found' };
export const AUDIT_NOTE = 'New evaluations and replay decisions are recorded for audit; the original decisions are unchanged.';
export const RUN_AGAIN_NOTE = 'Runs the same scripted scenario again as a new run. Its allowed sandbox writes happen again; it does not run a modified agent. The original run\'s records are unchanged.';

/** deps: { api(path, opts), rerender(), canRun() } */
export function createRecheck(deps) {
  const panels = new Map();   // runId → { html }

  function cardActions(runId) {
    const admin = deps.canRun();
    return `<button type="button" class="btn small" data-card-action="recheck" data-recheck>Re-check with the current judge and policy</button>
      <button type="button" class="btn small" data-card-action="run-again" data-run-again ${admin ? '' : 'disabled title="needs an admin key"'}>Run this scenario again</button>`;
  }
  const panelHtml = runId => {
    const p = panels.get(runId);
    return `<div class="card-panel"><p class="lv-meta run-again-note" data-run-again-note>${esc(RUN_AGAIN_NOTE)}</p>${p ? p.html : ''}</div>`;
  };

  async function recheck(runId) {
    panels.set(runId, { html: '<div class="recheck-result"><p class="lv-meta">Re-checking… (real judge calls)</p></div>' }); deps.rerender();
    try {
      const d = await deps.api(`/v1/runs/${encodeURIComponent(runId)}`);
      const steps = [];
      for (const t of d.timeline ?? []) {
        if (!['pre_tool', 'post_generation', 'pre_input'].includes(t.event?.boundary)) continue;
        const orig = (t.decisions ?? []).filter(x => !x.replay_of).at(-1);
        if (orig) steps.push({ id: orig.decision_id, label: t.event.operation?.tool ?? (t.event.boundary === 'post_generation' ? 'agent statement' : 'input read') });
      }
      const pick = steps.slice(0, 20);
      if (!pick.length) { panels.set(runId, { html: '<div class="recheck-result"><p class="lv-meta">Nothing in this run was decided yet.</p></div>' }); deps.rerender(); return; }
      const r = await deps.api('/v1/replays', { method: 'POST', body: { kind: 'model_reeval', decision_ids: pick.map(x => x.id) } });
      const byId = Object.fromEntries(pick.map(x => [x.id, x.label]));
      let changed = 0, unchanged = 0, skipped = 0;
      const rows = (r.results ?? []).map(x => {
        if (x.error) { skipped++; return `<li class="recheck-row" data-status="${x.error === 'not_found' ? 'error' : 'skipped'}"><b class="mono">${esc(byId[x.decision_id])}</b> <span class="lv-meta">${esc(SKIP[x.error] ?? `error: ${x.error}`)}</span></li>`; }
        const same = x.before.recommended === x.after.recommended;
        same ? unchanged++ : changed++;
        return `<li class="recheck-row" data-status="${same ? 'unchanged' : 'changed'}"><b class="mono">${esc(byId[x.decision_id])}</b> ${same
          ? `<span class="lv-meta">unchanged: ${esc(word(x.before.recommended))}</span>`
          : `<span class="changed">changed: ${esc(word(x.before.recommended))} → ${esc(word(x.after.recommended))}</span>`}${x.after.status && x.after.status !== 'ok' ? ` <span class="lv-meta">(judge status ${esc(x.after.status)})</span>` : ''}</li>`;
      });
      panels.set(runId, { html: `<div class="recheck-result">
        <div class="recheck-head"><b>Re-check with the current judge and policy</b> <span class="lv-meta"><span data-judge-calls>${esc(r.judge_calls)}</span> judge call attempt${r.judge_calls === 1 ? '' : 's'} · ${changed} changed · ${unchanged} unchanged · ${skipped} skipped</span></div>
        <ul class="recheck-rows">${rows.join('')}</ul>${steps.length > pick.length ? `
        <p class="lv-meta" data-recheck-omitted>Only the first ${pick.length} of ${steps.length} decided steps were re-checked (the replay API takes 20 at a time).</p>` : ''}
        <p class="lv-meta" data-audit-note>${esc(AUDIT_NOTE)} It re-assesses the recorded actions; it does not run a changed agent.</p></div>` });
    } catch (e) {
      panels.set(runId, { html: `<div class="recheck-result"><p class="note bad">Re-check failed: ${esc(e.message)}</p></div>` });
    }
    deps.rerender();
  }

  async function runAgain(runId, btn) {
    if (btn) btn.disabled = true;
    try {
      const r = await deps.api('/v1/sandbox/reexec', { method: 'POST', body: { run_id: runId }, role: 'admin' });
      panels.set(runId, { html: `<p class="lv-meta" data-run-again-result>Started a new run: <span class="mono">${esc(r.run_id)}</span>. It appears at the top of the runs list.</p>` });
    } catch (e) {
      panels.set(runId, { html: `<p class="note bad">Run again failed: ${esc(e.message)}</p>` });
    }
    deps.rerender();
  }

  return { cardActions, panelHtml, onAction: (action, runId, el) => (action === 'recheck' ? recheck(runId) : action === 'run-again' ? runAgain(runId, el) : undefined) };
}
