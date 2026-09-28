// Small DOM and formatting helpers for the UI modules.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ESC[c]);

export const fmtMs = v => (v == null || Number.isNaN(v) ? '—' : `${Math.round(v)} ms`);
export const fmtPct = v => (v == null || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(1)}%`);
export const fmtP = v => (v == null ? '—' : Number(v).toFixed(3));
export const fmtUsd = v => (v == null || Number.isNaN(v) ? '—' : `$${v < 0.1 ? v.toFixed(4) : v.toFixed(2)}`);
export function fmtClock(ms) {
  const s = Math.max(0, ms) / 1000;
  return `t+${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

export const chip = (text, cls = '', attrs = '') => `<span class="chip ${cls}" ${attrs}>${esc(text)}</span>`;
export const decisionChip = d => chip(d, esc(d));

export const deepClone = o => JSON.parse(JSON.stringify(o));

/** Which envelope-level fields describe a tool, whatever shape the engine used. */
export const toolName = env => env?.tool?.name ?? null;

export const ACTION_TEXT = {
  allow: 'allow', allow_and_alert: 'allow + alert', hold_for_review: 'hold for review',
  hold_for_approval: 'hold for approval', deny: 'deny', review_ticket: 'open review ticket',
  stop_and_handover: 'stop + hand over to a human',
};
