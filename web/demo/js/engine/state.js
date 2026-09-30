// State Engine (T1): turn a raw span into a dense, redacted decision snapshot.
//
// The feature definitions below are fixed by CONTRACT.md §3 and are the ONLY
// inputs the Jev simulator may read (plus seeded jitter) — no span ids, names
// or labels may be used to pick probabilities.

import { STATE_SCHEMA } from './types.js';

const SENSITIVE_FIELDS = new Set(['bank_account_number', 'routing_number', 'tax_id', 'ssn', 'session_token']);
const UNTRUSTED_TRUST = new Set(['retrieved', 'tool']);
const STOPWORDS = new Set(['llc', 'ltd', 'inc', 'co', 'corp']);
const IMPACT_NUM = { read: 0, write: 1, payment: 2 };

/**
 * Injection markers (documented weights). Each marker contributes its weight
 * once per untrusted source it matches; the score is the sum capped at 1.
 *   "ignore (all) previous / disregard prior / forget above"   0.9
 *   "also email / send a copy / cc me / forward a copy"        0.6
 *   "updated/new/revised … procedure/process/policy/step"      0.4
 *   an email address outside the tenant's domain allowlist     0.5
 * SOC (logs/2026-09-30_DEMO_SOC_PLAN.md §2); only the attack question reads them:
 *   text addressed to automation ("note/message/instruction to … automation/ai/agent/assistant/bot")  0.6
 *   a security-action imperative inside untrusted text (allowlist/whitelist/suspend/disable/close this ticket)  0.5
 */
const INJECTION_MARKERS = [
  { re: /ignore\s+(all\s+)?previous|disregard\s+(all\s+)?(prior|previous|above)|forget\s+(all\s+)?(prior|previous)/i, w: 0.9 },
  { re: /also\s+email|send\s+(a\s+)?copy|cc\s+(me|them|us)|forward\s+(this|it|a\s+copy)/i, w: 0.6 },
  { re: /(updated|new|revised|changed)\b[^.\n]*?\b(procedure|process|policy|instruction|step)/i, w: 0.4 },
  { re: /(?:note|message|instruction)\b[^.\n]{0,80}?\bto\s+(?:the\s+)?(?:security\s+)?(?:automation|ai|agent|assistant|bot)/i, w: 0.6 },
  { re: /allowlist|whitelist|suspend|disable|close\s+this\s+ticket/i, w: 0.5 },
];

export function domainOf(emailOrDomain) {
  if (emailOrDomain == null) return null;
  const at = emailOrDomain.indexOf('@');
  return at >= 0 ? emailOrDomain.slice(at + 1) : emailOrDomain;
}

/** Host of a URL string, or null when it is not a parseable http(s) URL. */
function urlHost(url) {
  if (typeof url !== 'string' || !url) return null;
  try { return new URL(url).hostname || null; } catch { return null; }
}

/** Normalise a name for token Jaccard: lower-case, punctuation → space, drop stopwords. */
export function normalizeName(name) {
  if (name == null) return null;
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t && !STOPWORDS.has(t));
}

/** Token Jaccard of two normalised token lists (null when both empty). */
export function tokenJaccard(a, b) {
  const sa = new Set(a), sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return null;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? null : inter / union;
}

function injectionMarkerScore(untrustedSources, tenant) {
  let score = 0;
  const emails = [];
  for (const s of untrustedSources) {
    const text = s.excerpt ?? s.text ?? '';
    for (const m of INJECTION_MARKERS) if (m.re.test(text)) score += m.w;
    const found = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
    if (found) emails.push(...found);
  }
  for (const e of emails) {
    const dom = e.slice(e.indexOf('@') + 1).toLowerCase();
    if (!tenant.domain_allowlist.includes(dom)) score += 0.5;
  }
  return Math.min(1, score);
}

function untrustedTextShare(text, sources) {
  let total = (text ?? '').length;
  let untrusted = 0;
  for (const s of sources) {
    const len = (s.text ?? '').length;
    total += len;
    if (UNTRUSTED_TRUST.has(s.trust)) untrusted += len;
  }
  return total === 0 ? null : untrusted / total;
}

/** Count of numbers / capitalised entities in `text` absent from all source text. */
function unsupportedClaims(text, sources) {
  if (text == null) return null;
  const haystack = sources.map(s => s.text ?? '').join('\n');
  const numbers = text.match(/\$?\d[\d,]*/g) ?? [];
  const caps = text.match(/[A-Z][a-zA-Z]{1,}/g) ?? [];
  let count = 0;
  for (const c of [...numbers, ...caps]) if (!haystack.includes(c)) count++;
  return count;
}

/**
 * Redaction for the safeView: strip numbers and account references so the judge
 * never sees raw amounts or account identifiers (CONTRACT §3 "no account refs /
 * numbers"). Email addresses (no digits) survive so a marker can be traced, but
 * numeric payloads do not.
 */
function redact(text) {
  return String(text)
    .replace(/\$?\d[\d,]*/g, '[redacted]')
    .replace(/\bACCT\w*(?:[-_]\w+)*\b/gi, '[redacted]');
}

export function buildState(span, history, tenant, now) {
  const ctx = span.context ?? {};
  const invoice = ctx.invoice ?? null;
  const bank = ctx.bank_account ?? null;
  const approval = ctx.approval; // undefined = n/a, null = missing
  const tool = span.tool ?? null;
  const args = tool?.args ?? {};
  const result = span.result ?? null;
  const readback = span.readback ?? null;
  const sources = (span.sources ?? []).map(s => ({
    id: s.id,
    trust: s.trust,
    excerpt: (s.text ?? '').slice(0, 280),
  }));

  const dest_domain = args.remit_domain ?? domainOf(args.to) ?? urlHost(args.url) ?? null;
  const domain_allowed = dest_domain == null ? null : tenant.domain_allowlist.includes(dest_domain);
  const amount_usd = invoice?.amount_usd ?? args.amount_usd ?? null;

  // SOC facts (logs/2026-09-30_DEMO_SOC_PLAN.md §2). Null unless the span has a SOC tool/context, so AP is unaffected.
  const socAlert = ctx.soc?.alert ?? null;
  const target_user = args.user_id ?? null;
  const target_ip = args.ip ?? null;
  const target_ticket = args.ticket_id ?? null;
  const socUser = target_user != null ? (tenant.soc_users?.[target_user] ?? null) : null;
  const target_privileged = tool?.name === 'identity.suspend_user'
    ? (socUser != null ? (socUser.privileged || socUser.break_glass) : false)
    : null;
  const incident_approved_for_target = target_user != null
    ? (tenant.soc_incidents ?? []).some(inc => inc.target_user === target_user && inc.action === 'suspend' && inc.status === 'approved')
    : null;
  const change_approved_for_ip = target_ip != null
    ? (tenant.soc_change_approvals ?? []).some(ch => ch.ip === target_ip && ch.action === 'allowlist' && ch.status === 'approved')
    : null;

  const facts = {
    amount_usd,
    approval_limit_usd: tenant.approval_limit_usd,
    has_approval_evidence: approval === undefined ? null : (approval != null && approval.status === 'approved'),
    approval_ref: approval?.id ?? null,
    payee_invoice: invoice?.vendor ?? null,
    payee_account_holder: bank?.holder ?? null,
    dest_domain,
    domain_allowed,
    readback_posted: readback?.posted ?? null,
    tool_status: result?.status ?? null,
    target_user,
    target_ip,
    target_privileged,
    incident_approved_for_target,
    change_approved_for_ip,
  };

  const payee_similarity = (invoice?.vendor != null && bank?.holder != null)
    ? tokenJaccard(normalizeName(invoice.vendor), normalizeName(bank.holder))
    : null;

  const sensitive_fields_in_args = tool == null
    ? null
    : (args.includes_fields
        ? args.includes_fields.filter(f => SENSITIVE_FIELDS.has(f)).length
        : 0);

  const injection_marker_score = injectionMarkerScore(
    sources.filter(s => UNTRUSTED_TRUST.has(s.trust)), tenant);

  const untrusted_text_share = untrustedTextShare(span.text, span.sources ?? []);
  const amount_ratio = amount_usd == null ? null : amount_usd / tenant.approval_limit_usd;
  const tool_impact = tool == null ? null : (IMPACT_NUM[tool.impact] ?? null);
  const unsupported_claims = unsupportedClaims(span.text, span.sources ?? []);
  const repeat_failures = (history ?? []).filter(h =>
    h.trace_id === span.trace_id && h.features?.tool_status_error).length;
  const tool_status_error = result == null ? null : (result.status < 200 || result.status >= 300);

  // target_matches_alert (plan §2): 1 when the target user/IP equals the alert's entity, or the target ticket links
  // to the alert via TENANT.soc_tickets; 0 when the tool has a target that matches none of these (a ticket linked to
  // another alert, or unknown, counts 0); null when there is no SOC target or no context.soc.alert.
  let target_matches_alert = null;
  if (socAlert != null && (target_user != null || target_ip != null || target_ticket != null)) {
    const userMatch = target_user != null && target_user === socAlert.entity_user;
    const ipMatch = target_ip != null && target_ip === socAlert.entity_ip;
    const ticketMatch = target_ticket != null && tenant.soc_tickets?.[target_ticket] === socAlert.id;
    target_matches_alert = (userMatch || ipMatch || ticketMatch) ? 1 : 0;
  }
  // prior_same_action (plan §2): earlier pre_tool envelopes in the same trace with the same tool name and a non-read impact.
  const prior_same_action = tool == null
    ? null
    : (history ?? []).filter(h =>
        h.trace_id === span.trace_id
        && h.boundary === 'pre_tool'
        && h.tool?.name === tool.name
        && (h.tool?.impact === 'write' || h.tool?.impact === 'payment')).length;

  const features = {
    payee_similarity,
    sensitive_fields_in_args,
    domain_allowed,
    injection_marker_score,
    untrusted_text_share,
    amount_ratio,
    tool_impact,
    unsupported_claims,
    repeat_failures,
    tool_status_error,
    target_matches_alert,
    prior_same_action,
  };

  const evidence_refs = [];
  if (tool) evidence_refs.push('tool:args');
  if (invoice) evidence_refs.push('context:invoice');
  if (bank) evidence_refs.push('context:bank_account');
  if (approval !== undefined) evidence_refs.push('context:approval');
  if (ctx.po) evidence_refs.push('context:po');
  if (result) evidence_refs.push('tool:result');
  if (readback) evidence_refs.push('tool:readback');
  for (const s of sources) evidence_refs.push(`source:${s.id}`);

  const safeView = {
    boundary: span.boundary,
    tool: tool ? { name: tool.name, impact: tool.impact } : null,
    arg_keys: tool ? Object.keys(args) : [],
    features,
    sources: sources.map(s => ({ trust: s.trust, excerpt: redact(s.excerpt) })),
  };

  return {
    schema_version: STATE_SCHEMA,
    event_id: span.span_id,
    trace_id: span.trace_id,
    span_id: span.span_id,
    tenant: tenant.id,
    boundary: span.boundary,
    ts: now,
    age_ms: span.age_ms ?? 0,
    stale: (span.age_ms ?? 0) > tenant.stale_after_ms,
    tool,
    facts,
    features,
    sources,
    evidence_refs,
    safeView,
  };
}
