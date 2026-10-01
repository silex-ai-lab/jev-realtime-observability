// Runs view (logs/2026-09-30_CONSOLE_UX_PLAN.md §2): one card per run, one plain-language line per step.
// It renders only server records (stream records and GET /v1/runs/:id); the wording comes from verdict.js.
// It never replaces the Engineer view: live.js keeps rendering the stream, inspector and KPI tiles underneath.
import { callKind, claimTimeLines, lineVerdict, signalsLine, summarize, whyLine } from './verdict.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ESC[c]);
const OUTCOME_TOOLS = new Set(['payments.execute', 'email.send']);
const OUTCOME_TEXT = { pending: 'pending', verified_success: 'verified', verified_failure: 'verified failure', mismatch: 'mismatch', unknown_after_deadline: 'unknown after deadline' };
const REVIEW_NOTE = 'Answering the review records labels for training; it does not approve, release or run the action.';
const MAX_RUNS = 50;

/**
 * deps: { api(path), inspect(eventId), mode(): 'gate'|'shadow'|null, onDetails(eventId) }
 * Returns null when the page has no Runs view containers (e.g. the live-evict fixture).
 */
export function createRunsView(deps) {
  const root = document.querySelector('#runs');
  if (!root) return null;
  const runs = new Map();          // run_id → { runId, events: Map(event_id → rec), detail: Map(event_id → event), fetchTimer, finished }
  const byOperation = new Map();   // operation_id → post_tool event_id (to join outcomes and receipts)
  let tools = {}, unknownImpact = 'payment', titles = {}, domains = {}, openReviews = [];
  let renderTimer = null;
  // Retention: the view keeps the newest MAX_RUNS runs (plus the run the viewer selected). Older runs are forgotten,
  // timers included, so a long session does not grow memory; their late records are ignored, not resurrected.
  const evicted = new Set();
  let evictedCount = 0, pinnedShown = false;

  const runOf = runId => {
    if (evicted.has(runId)) return null;
    let r = runs.get(runId);
    if (!r) { r = { runId, events: new Map(), detail: new Map(), fetchTimer: null, finished: false, scenario: null }; runs.set(runId, r); }
    return r;
  };
  const recOf = (r, eventId) => {
    let x = r.events.get(eventId);
    if (!x) { x = { event: null, decisions: [], outcomes: [], evaluations: [] }; r.events.set(eventId, x); }
    return x;
  };
  const scheduleFetch = r => {
    clearTimeout(r.fetchTimer);
    r.fetchTimer = setTimeout(async () => {
      try {
        const d = await deps.api(`/v1/runs/${encodeURIComponent(r.runId)}`);
        for (const t of d.timeline ?? []) if (t.event?.event_id) r.detail.set(t.event.event_id, t.event);
      } catch { /* the card still renders from stream records */ }
      scheduleRender();
    }, r.finished ? 50 : 400);
  };
  const scheduleRender = () => { renderTimer ??= setTimeout(() => { renderTimer = null; render(); }, 100); };

  function onRecord(rec) {
    const p = rec.payload ?? {};
    if (rec.kind === 'event') {
      const r = runOf(p.run_id);
      if (!r) return;
      recOf(r, p.event_id).event = p;
      if (p.boundary === 'run_started') { r.scenario = p.attributes?.scenario ?? r.scenario; r.goal = p.task_goal ?? r.goal; }
      if (p.boundary === 'run_finished') r.finished = true;
      if (p.boundary === 'post_tool' && p.operation_id) byOperation.set(p.operation_id, p.event_id);
      scheduleFetch(r);
    } else if (rec.kind === 'decision' && p.event_id) {
      for (const r of runs.values()) if (r.events.has(p.event_id)) { if (!p.replay_of) r.events.get(p.event_id).decisions.push(p); break; }
    } else if (rec.kind === 'evaluation' && p.event_id) {
      for (const r of runs.values()) if (r.events.has(p.event_id)) { r.events.get(p.event_id).evaluations.push(p); break; }
    } else if (rec.kind === 'outcome' && p.event_id) {
      for (const r of runs.values()) if (r.events.has(p.event_id)) { r.events.get(p.event_id).outcomes.push(p); break; }
    } else return;
    scheduleRender();
  }

  function setScenarioMeta({ scenarios, tools: t, unknown_tool_impact: u }) {
    for (const s of scenarios ?? []) { titles[s.id] = s.title; domains[s.id] = s.domain ?? 'ap'; }
    if (t && typeof t === 'object') tools = t;
    if (u) unknownImpact = u;
    scheduleRender();
  }
  function setReviews(list) { openReviews = Array.isArray(list) ? list : []; scheduleRender(); }

  /** Builds the ordered steps of one run from stream records plus the run detail. */
  const modeOf = (decision, pageMode) => { const m = decision?.provenance?.enforcement_mode; return m === 'gate' || m === 'shadow' ? m : pageMode; };
  function stepsOf(r, mode) {
    const all = [...r.events.values()].filter(x => x.event).sort((a, b) => a.event.producer_seq - b.event.producer_seq);
    const post = new Map();   // operation_id → post_tool rec
    for (const x of all) if (x.event.boundary === 'post_tool' && x.event.operation_id) post.set(x.event.operation_id, x);
    const steps = [];
    for (const x of all) {
      const ev = x.event, det = r.detail.get(ev.event_id) ?? {};
      const decision = x.decisions.at(-1) ?? null;
      if (ev.boundary === 'run_started') {
        if (ev.task_goal) steps.push({ kind: 'task', eventId: ev.event_id, text: ev.task_goal });
      } else if (ev.boundary === 'pre_input') {
        const srcs = (det.sources ?? []).filter(s => s.instruction_authority === 'none');
        steps.push({ kind: 'source', eventId: ev.event_id, sources: srcs, decision, signals: signalsLine(x.evaluations) });
      } else if (ev.boundary === 'pre_tool') {
        const pt = ev.operation_id ? post.get(ev.operation_id) : null;
        const attrs = pt?.event?.attributes ?? {};
        const impact = tools[ev.tool] ?? (Object.keys(tools).length ? unknownImpact : null);
        // Each step keeps the mode its own decision was made in (plan r7 C1'); the page mode is only a fallback.
        const stepMode = modeOf(decision, mode);
        const kind = stepMode === 'shadow' ? 'ungated' : callKind({ mode: stepMode ?? 'gate', controlAction: attrs.control_action, impact });
        steps.push({ kind, mode: stepMode, eventId: ev.event_id, postEventId: pt?.event?.event_id ?? null, tool: ev.tool, args: det.operation?.args ?? null,
          decision, receiptStatus: attrs.receipt_status, controlAction: attrs.control_action, impact,
          outcomes: pt ? pt.outcomes : [], signals: signalsLine(x.evaluations) });
      } else if (ev.boundary === 'post_generation') {
        steps.push({ kind: 'statement', mode: modeOf(decision, mode), eventId: ev.event_id, text: det.text ?? null, decision, signals: signalsLine(x.evaluations) });
      } else if (ev.boundary === 'post_tool') {
        // A decision on a completed call is a finding after the fact. It never changes the call's receipt.
        const paired = ev.operation_id && all.some(y => y.event.boundary === 'pre_tool' && y.event.operation_id === ev.operation_id);
        if (!paired || (decision && decision.recommended !== 'NO_CONFIGURED_RISK'))
          steps.push({ kind: 'finding', mode: modeOf(decision, mode), eventId: ev.event_id, tool: ev.tool, decision,
            evidence: ev.attributes?.evidence ?? (ev.result_status ? `tool reported ${ev.result_status}` : null), signals: signalsLine(x.evaluations) });
      }
    }
    return steps;
  }

  // Key argument shown on the line; the full argument list is in the tooltip.
  const KEY_ARG = ['ip', 'user_id', 'ticket_id', 'alert_id', 'url', 'invoice_id', 'to', 'vendor_id', 'po_id'];
  const argText = args => {
    if (!args || typeof args !== 'object') return { short: '', full: '' };
    const full = Object.entries(args).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
    const k = KEY_ARG.find(x => args[x] != null);
    let short = k ? String(args[k]) : '';
    if (k === 'url') { try { short = new URL(short).hostname; } catch { /* keep */ } }
    return { short, full };
  };
  const ICON = {
    task: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5" r="3"/><path d="M2.5 14c.8-3 2.9-4.5 5.5-4.5s4.7 1.5 5.5 4.5"/></svg>',
    source: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M9.5 1.5v3h3"/></svg>',
    call: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 4 1.5 8 5 12M11 4l3.5 4L11 12"/></svg>',
    statement: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h12v8H6l-3 2.5V11H2z"/></svg>',
    ran: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8.5 3 3 7-7"/></svg>',
    stop: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 1.5h5l4 4v5l-4 4h-5l-4-4v-5z"/><path d="M5 8h6"/></svg>',
    warn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8 15 14H1z"/><path d="M8 6v3.5M8 11.5v.5"/></svg>',
    pending: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.5V8l2.5 1.5"/></svg>',
  };
  const TONE_ICON = { ok: 'ran', stop: 'stop', warn: 'warn', fail: 'warn', pending: 'pending' };
  const chip = v => `<span class="step-verdict" data-tone="${esc(v.tone)}">${ICON[TONE_ICON[v.tone]] ?? ''}<span class="vt">${esc(v.text)}</span></span>`;
  // .step-verdict's text must be exactly lineVerdict().text: the icon is an SVG with no text.
  const sigLine = s => (deps.signals !== false && s.signals ? `<div class="step-signals"><span class="sub-label">${esc(s.signals.label)}</span> <span class="mono">${esc(s.signals.text)}</span></div>` : '');

  function stepHtml(s, n, mode) {
    const node = kind => `<span class="step-node" data-node="${kind}">${ICON[kind]}</span>`;
    if (s.kind === 'task') return `<li class="step" data-step-kind="task" data-event-id="${esc(s.eventId)}">${node('task')}<div class="step-body"><div class="step-line"><span class="step-label">Task</span><span class="step-text">${esc(s.text)}</span></div></div></li>`;
    if (s.kind === 'source') {
      const q = s.sources.map(x => `<blockquote class="step-untrusted" title="${esc(x.excerpt)}">${esc(x.excerpt)}</blockquote>`).join('');
      return `<li class="step" data-step-kind="source" data-event-id="${esc(s.eventId)}">${node('source')}<div class="step-body"><div class="step-line"><span class="step-label">Read</span>${s.sources.length ? '<span class="tag warn">untrusted text from outside</span>' : '<span class="step-text">input</span>'}${s.sources.length ? '<button type="button" class="linkbtn more" data-expand>show</button>' : ''}</div>${q}${sigLine(s)}</div></li>`;
    }
    const d = s.decision;
    const details = (t, label) => `<button class="linkbtn" type="button" data-details="${t}" data-target="${esc(t === 'decision' ? s.eventId : s.postEventId)}">${label}</button>`;
    if (s.kind === 'finding') {
      const v = lineVerdict({ mode: s.mode ?? mode, kind: 'statement', recommended: d?.recommended ?? null, decidedBy: d?.decided_by });
      const why = whyLine(d);
      return `<li class="step" data-step-kind="finding" data-event-id="${esc(s.eventId)}" data-tool="${esc(s.tool ?? '')}" data-tone="${esc(v.tone)}">${node('source')}<div class="step-body">
        <div class="step-line"><span class="step-label">Found</span><span class="step-call"><b class="mono">${esc(s.tool ?? 'after the call')}</b></span>${chip(v)}<span class="step-links">${d ? details('decision', 'details') : ''}</span></div>
        ${s.evidence ? `<div class="step-evidence lv-meta">${esc(s.evidence)} · a finding after the call; it does not change whether the call ran</div>` : '<div class="step-evidence lv-meta">a finding after the call; it does not change whether the call ran</div>'}
        ${why ? `<div class="step-why-wrap"><ul class="step-why">${why.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>${why.passedNote ? `<span class="step-why-passed">${esc(why.passedNote)}</span>` : ''}</div>` : ''}
        ${sigLine(s)}</div></li>`;
    }
    if (s.kind === 'statement') {
      const v = lineVerdict({ mode: s.mode ?? mode, kind: 'statement', recommended: d?.recommended ?? null, decidedBy: d?.decided_by });
      const why = d && d.recommended !== 'NO_CONFIGURED_RISK' && (d.rule_results ?? []).some(x => x.verdict !== 'PASS') ? whyLine(d) : null;
      const ct = claimTimeLines(d);
      return `<li class="step" data-step-kind="statement" data-event-id="${esc(s.eventId)}">${node('statement')}<div class="step-body">
        <div class="step-line"><span class="step-label">Said</span><span class="step-text quote">${s.text ? `“${esc(s.text)}”` : '…'}</span>${chip(v)}${d ? details('decision', 'details') : ''}</div>
        ${why ? `<ul class="step-why">${why.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>${why.passedNote ? `<span class="step-why-passed">${esc(why.passedNote)}</span>` : ''}` : ''}
        ${ct.length ? `<div class="step-claim-time"><span class="sub-label">At the time the agent said this:</span><ul>${ct.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}${sigLine(s)}</div></li>`;
    }
    const v = lineVerdict({ mode: s.mode ?? mode, kind: s.kind, recommended: d?.recommended ?? null, decidedBy: d?.decided_by, receiptStatus: s.receiptStatus, controlAction: s.controlAction, impact: s.impact });
    const why = whyLine(d);
    const waiting = d && openReviews.some(t => t.decision_id === d.decision_id);
    const oc = s.outcomes.at(-1);
    const a = argText(s.args);
    const outcomeLine = deps.outcomes !== false && OUTCOME_TOOLS.has(s.tool) && s.receiptStatus === 'executed'
      ? `<div class="step-outcome" data-outcome-state="${esc(oc?.state ?? 'pending')}"><span class="sub-label">Business result</span> <b>${esc(OUTCOME_TEXT[oc?.state] ?? oc?.state ?? 'pending')}</b> <span class="lv-meta">checked independently · “ran” means only that the call ran</span></div>` : '';
    return `<li class="step" data-step-kind="${esc(s.kind)}" data-event-id="${esc(s.eventId)}" data-tool="${esc(s.tool)}" data-tone="${esc(v.tone)}">${node('call')}<div class="step-body">
      <div class="step-line"><span class="step-call" title="${esc(a.full)}"><b class="mono">${esc(s.tool)}</b>${a.short ? ` <span class="arg mono">${esc(a.short)}</span>` : ''}</span>
        ${chip(v)}${v.contradiction ? '<span class="step-contradiction tag warn" data-contradiction="true">records disagree · see details</span>' : ''}
        <span class="step-links">${d ? details('decision', 'details') : ''}${s.postEventId ? details('outcome', 'result') : ''}</span></div>
      ${why ? `<div class="step-why-wrap"><ul class="step-why">${why.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>${why.passedNote ? `<span class="step-why-passed">${esc(why.passedNote)}</span>` : ''}</div>` : ''}
      ${waiting ? `<div class="step-waiting"><span class="tag violet" title="${esc(REVIEW_NOTE)}">waiting for a person</span> <span class="lv-meta" data-review-note>${esc(REVIEW_NOTE)}</span></div>` : ''}
      ${outcomeLine}${sigLine(s)}</div></li>`;
  }

  let selectedRun = null;
  function render() {
    const mode = deps.mode();
    const sorted = [...runs.values()].sort((a, b) => maxSeq(b) - maxSeq(a));
    if (!selectedRun || !runs.has(selectedRun) || autoFollow) selectedRun = (sorted.slice(0, MAX_RUNS).find(followable) ?? sorted[0])?.runId ?? null;
    const ordered = sorted.slice(0, MAX_RUNS);
    const pinned = sorted.slice(MAX_RUNS).find(r => r.runId === selectedRun);
    if (pinned) ordered.push(pinned);   // a manually selected older run stays on screen until the viewer picks another
    pinnedShown = !!pinned;
    for (const r of sorted.slice(MAX_RUNS)) if (r !== pinned) evict(r);
    const allCalls = [], rowsHtml = [];
    root.innerHTML = ordered.length ? ordered.map(r => {
      const steps = stepsOf(r, mode);
      const calls = steps.filter(s => s.kind === 'gated' || s.kind === 'ungated');
      allCalls.push(...calls);
      const sum = summarize(calls);
      const flagged = calls.filter(c => ['HOLD', 'BLOCK', 'STOP', 'REJECT', 'REVIEW', 'UNKNOWN'].includes(c.decision?.recommended)).length;
      const stoppedN = mode === 'shadow' ? flagged : sum.stoppedBySilex;
      const stoppedLabel = mode === 'shadow' ? 'would have been held or blocked' : 'held or blocked';
      const findings = steps.filter(x => x.kind === 'finding' && x.decision && x.decision.recommended !== 'NO_CONFIGURED_RISK');
      const tone = stoppedN ? 'stop' : sum.failed ? 'fail' : !r.finished ? 'pending' : findings.length || calls.some(c => c.decision && c.decision.recommended !== 'NO_CONFIGURED_RISK') ? 'warn' : 'ok';
      const title = titles[r.scenario] ?? r.goal ?? r.scenario ?? 'Run';
      const sel = r.runId === selectedRun;
      rowsHtml.push(`<button type="button" class="run-row" data-run-row="${esc(r.runId)}" aria-current="${sel}" data-tone="${tone}"><i class="dot"></i><span class="rr-id">${esc(r.scenario ?? '·')}</span><span class="rr-title">${esc(title)}</span><span class="rr-counts">${stoppedN ? `<span class="c stop">${stoppedN}</span>` : ''}<span class="c ran">${sum.ran}</span></span></button>`);
      return `<article class="run-card" data-run-id="${esc(r.runId)}" data-scenario="${esc(r.scenario ?? '')}"${sel ? ' data-selected' : ''}>
        <header class="run-head"><div class="run-title">${r.scenario ? `<span class="id-pill">${esc(r.scenario)}</span>` : ''}${esc(title)}${deps.simulated ? '<span class="tag warn sim-tag">simulated</span>' : ''}</div>
          ${deps.cardActions ? `<div class="run-actions">${deps.cardActions(r.runId, r)}</div>` : ''}
          <div class="run-stats" data-run-summary>this run: ${sum.calls} tool call${sum.calls === 1 ? '' : 's'} · ${stoppedN} ${stoppedLabel} · ${sum.ran} ran${sum.failed ? ` · ${sum.failed} failed` : ''}${sum.pending ? ` · ${sum.pending} pending` : ''}${r.finished ? '' : ' · running…'}</div></header>
        <ol class="steps">${steps.map((s, i) => stepHtml(s, i + 1, mode)).join('')}</ol>${deps.panelHtml ? deps.panelHtml(r.runId) : ''}</article>`;
    }).join('') : '<div class="empty-state"><h3>Nothing has run yet</h3><p>Start a scenario with <b>Run a scenario</b>. Each run appears on the left; its steps appear here.</p></div>';
    const list = document.querySelector('#run-rows');
    if (list) list.innerHTML = rowsHtml.join('') || '<p class="lv-empty">No runs yet.</p>';
    const cnt = document.querySelector('#runs-count'); if (cnt) cnt.textContent = ordered.length ? String(ordered.length) : '';
    renderSummary(summarize(allCalls), mode, allCalls);
  }
  function evict(r) {
    clearTimeout(r.fetchTimer);
    for (const x of r.events.values()) if (x.event?.boundary === 'post_tool' && x.event.operation_id) byOperation.delete(x.event.operation_id);
    runs.delete(r.runId); evictedCount++;
    evicted.add(r.runId);
    // Remembered for the newest 5000 evictions; a record for an older evicted run would start a new partial card.
    if (evicted.size > 5000) evicted.delete(evicted.values().next().value);
  }
  let autoFollow = true;   // follow the newest run until the viewer picks one
  // deps.followable(run): which runs auto-follow may jump to. The demo passes scenario runs only, so its background traffic
  // does not take over the card a viewer is looking at.
  const followable = r => (deps.followable ? deps.followable(r) : true);
  const maxSeq = r => Math.max(0, ...[...r.events.values()].map(x => (x.event ? Date.parse(x.event.received_at) || 0 : 0)));

  function renderSummary(sum, mode, calls) {
    const el = document.querySelector('#runs-summary'); if (!el) return;
    const wouldStop = calls.filter(c => ['HOLD', 'BLOCK', 'STOP', 'REJECT', 'REVIEW', 'UNKNOWN'].includes(c.decision?.recommended)).length;
    const n = (k, v, label, tone) => `<span class="stat" data-tone="${tone}"><b data-count="${k}">${v}</b><span>${label}</span></span>`;
    el.innerHTML = [
      n('calls', sum.calls, 'tool calls', 'neutral'),
      mode === 'shadow' ? n('wouldStop', wouldStop, 'would stop', 'warn') : n('stoppedBySilex', sum.stoppedBySilex, 'stopped', 'stop'),
      n('ran', sum.ran, 'ran', 'ok'),
      sum.failed ? n('failed', sum.failed, 'failed', 'fail') : '',
      sum.didNotRunOther ? n('didNotRunOther', sum.didNotRunOther, 'did not run (other)', 'warn') : '',
      sum.pending ? n('pending', sum.pending, 'pending', 'neutral') : '',
    ].join('') + (evictedCount ? `<span class="lv-meta" data-window>counts cover the ${MAX_RUNS} most recent runs${pinnedShown ? ' plus the selected older run' : ''}</span>` : '') + `<span hidden>${n('didNotRun', sum.didNotRun, '', '')}${n('waiting', openReviews.length, '', '')}</span>`;
    const wb = document.querySelector('#waiting-btn'), wn = document.querySelector('#waiting-n');
    if (wb && wn) { wn.textContent = String(openReviews.length); wb.hidden = openReviews.length === 0; }
  }

  document.querySelector('#run-rows')?.addEventListener('click', e => {
    const b = e.target.closest?.('[data-run-row]'); if (!b) return;
    selectedRun = b.dataset.runRow; autoFollow = selectedRun === [...runs.values()].filter(followable).sort((a, c) => maxSeq(c) - maxSeq(a))[0]?.runId; render();
  });
  root.addEventListener('click', e => {
    const x = e.target.closest?.('[data-expand]');
    if (x) { const st = x.closest('.step'); st?.classList.toggle('expanded'); x.textContent = st?.classList.contains('expanded') ? 'hide' : 'show'; }
  });

  root.addEventListener('click', e => {
    const b = e.target.closest?.('[data-details]');
    if (b) deps.onDetails(b.dataset.target);
    const act = e.target.closest?.('[data-card-action]');
    if (act && deps.onAction) deps.onAction(act.dataset.cardAction, act.closest('.run-card')?.dataset.runId, act);
  });

  /** Run ids, newest first (What-if and the demo use it). */
  /** Forget every run (the demo page re-feeds its whole simulated stream after each step). */
  function reset() { for (const r of runs.values()) clearTimeout(r.fetchTimer); runs.clear(); byOperation.clear(); evicted.clear(); evictedCount = 0; }
  const runIds = () => [...runs.values()].sort((a, b) => maxSeq(b) - maxSeq(a)).map(r => r.runId);
  /** Selects a run on behalf of the page (the demo after an injection). Like a click on its row: auto-follow stays on
   *  only when it is the newest followable run, so a viewer's later manual pick still pins. */
  function select(runId) {
    if (!runs.has(runId)) return false;
    selectedRun = runId;
    autoFollow = runId === [...runs.values()].filter(followable).sort((a, c) => maxSeq(c) - maxSeq(a))[0]?.runId;
    scheduleRender();   // like every other update: the card renders once its run detail has been fetched
    return true;
  }
  return { onRecord, setScenarioMeta, setReviews, render, runIds, reset, select, rerender: scheduleRender };
}
