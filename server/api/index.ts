// HTTP API (docs/CONTRACTS.md §5). node:http only. Tenant always comes from the credential.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { Db } from '../storage/db.ts';
import * as repos from '../storage/repos.ts';
import type { JudgeClient } from '../judges/index.ts';
import { judgeSourceOf, type EvaluationRecord } from '../../contracts/judge.ts';
import { ingestEvents, normaliseOtlp } from '../ingest/index.ts';
import { decide, validatePolicy, type PolicyBody } from '../policy/index.ts';
import type { PolicyDecision } from '../../contracts/decision.ts';
import type { DecisionSnapshot } from '../../contracts/snapshot.ts';

type Role = 'ingest' | 'reader' | 'gateway' | 'admin';
export interface ApiDeps {
  db: Db;
  judge: JudgeClient | null;
  realtimeTtlMs: number;
  webRoot: string | null;
  activePolicy: (tenantId: string) => Promise<PolicyBody>;
  notify: () => void;
  subscribe: (fn: () => void) => () => void;
  startSandboxRun: (tenantId: string, scenario: string) => Promise<{ run_id: string }>;
  sandboxScenarios: string[];
}

const MAX_BODY = 1 << 20;
class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(s);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new HttpError(413, 'too_large', 'body too large'); chunks.push(c as Buffer); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { throw new HttpError(400, 'bad_json', 'invalid JSON'); }
}

export function createApi(d: ApiDeps): Server {
  const streamTokens = new Map<string, { tenant_id: string; exp: number }>();
  const sandboxRate = new Map<string, number[]>();

  async function auth(req: IncomingMessage, roles: Role[]): Promise<{ tenant_id: string; role: Role }> {
    const h = req.headers.authorization ?? '';
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) throw new HttpError(401, 'unauthenticated', 'missing bearer key');
    const k = await repos.findApiKey(d.db, m[1]);
    if (!k) throw new HttpError(401, 'unauthenticated', 'unknown key');
    if (!roles.includes(k.role as Role)) throw new HttpError(403, 'forbidden', 'role not allowed');
    return { tenant_id: k.tenant_id, role: k.role as Role };
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://local');
    const p = url.pathname, m = req.method ?? 'GET';

    if (m === 'GET' && p === '/healthz') return send(res, 200, { ok: true });
    if (m === 'GET' && p === '/readyz') {
      let db = 'ok'; try { await d.db.query('SELECT 1'); } catch { db = 'error'; }
      let judge = 'not_configured';
      if (d.judge) judge = (await d.judge.describe().catch(() => null)) ? 'ok' : 'degraded';
      return send(res, db === 'ok' ? 200 : 503, { db, judge });
    }

    if (m === 'POST' && p === '/v1/events') {
      const a = await auth(req, ['ingest']);
      const body = await readJson(req) as { events?: unknown[] } | Record<string, unknown>;
      const list = Array.isArray((body as { events?: unknown[] })?.events) ? (body as { events: unknown[] }).events : [body];
      if (list.length === 0 || list.length > 100) throw new HttpError(400, 'bad_batch', '1..100 events');
      const r = await ingestEvents({ db: d.db, realtimeTtlMs: d.realtimeTtlMs, notify: d.notify }, a.tenant_id, list, 'sdk');
      if (r.some(x => x.status === 'conflict')) return send(res, 409, { error: { code: 'conflict', message: 'event id reused with different content' }, results: r });
      if (r.some(x => x.status === 'invalid')) return send(res, 400, { error: { code: 'invalid_event', message: 'schema validation failed' }, results: r });
      return send(res, 202, { accepted: r.map(x => ({ event_id: x.event_id, status: x.status })) });
    }
    if (m === 'POST' && p === '/v1/traces') {
      const a = await auth(req, ['ingest']);
      const { events } = normaliseOtlp(await readJson(req));
      const r = events.length ? await ingestEvents({ db: d.db, realtimeTtlMs: d.realtimeTtlMs, notify: d.notify }, a.tenant_id, events, 'otlp') : [];
      const rejected = r.filter(x => x.status === 'invalid' || x.status === 'conflict').length;
      return send(res, 200, rejected ? { partialSuccess: { rejectedSpans: String(rejected), errorMessage: 'some spans were not valid silex boundary events' } } : {});
    }

    if (m === 'GET' && p === '/v1/judge') {
      await auth(req, ['reader', 'admin']);
      const served = d.judge ? (await d.judge.describe().catch(() => null)) : null;
      return send(res, 200, { configured: Boolean(d.judge), backend: d.judge?.config.backend ?? null, served_model: served,
        judge_source: served ? judgeSourceOf(served) : null, wire_model: d.judge?.config.model ?? null });
    }
    if (m === 'GET' && p === '/v1/runs') {
      const a = await auth(req, ['reader', 'admin']);
      return send(res, 200, { runs: await repos.listRuns(d.db, a.tenant_id, Math.min(200, Number(url.searchParams.get('limit') ?? 50))) });
    }
    const runMatch = /^\/v1\/runs\/([A-Za-z0-9._:~\-]+)$/.exec(p);
    if (m === 'GET' && runMatch) {
      const a = await auth(req, ['reader', 'admin']);
      const events = await repos.listRunEvents(d.db, a.tenant_id, runMatch[1], null, 1000);
      if (!events.length) throw new HttpError(404, 'not_found', 'run not found');
      const timeline = [];
      for (const e of events) timeline.push({ event: e, evaluations: await repos.listEvaluationsForEvent(d.db, a.tenant_id, e.event_id),
        decisions: await repos.listDecisionsForEvent(d.db, a.tenant_id, e.event_id) });
      return send(res, 200, { run_id: runMatch[1], timeline });
    }
    const evMatch = /^\/v1\/evaluations\/([A-Za-z0-9._:~\-]+)$/.exec(p);
    if (m === 'GET' && evMatch) {
      const a = await auth(req, ['reader', 'admin']);
      const e = await repos.getEvaluation(d.db, a.tenant_id, evMatch[1]);
      if (!e) throw new HttpError(404, 'not_found', 'evaluation not found');
      return send(res, 200, { evaluation: e, snapshot: await repos.getSnapshot(d.db, a.tenant_id, e.snapshot_id), decisions: await repos.listDecisionsForEvent(d.db, a.tenant_id, e.event_id) });
    }

    if (m === 'GET' && p === '/v1/policies/active') {
      const a = await auth(req, ['reader', 'admin']);
      return send(res, 200, { policy: await d.activePolicy(a.tenant_id) });
    }
    if (m === 'POST' && p === '/v1/policies/drafts') {
      const a = await auth(req, ['admin']);
      const v = validatePolicy(await readJson(req));
      if (!v.ok) return send(res, 400, { ok: false, errors: v.errors });
      const draft_version = `${v.policy.policy_version}+draft-${randomUUID().slice(0, 8)}`;
      await d.db.tx(async q => {
        await repos.insertPolicyVersion(q, { policy_version: draft_version, tenant_id: a.tenant_id, base_version: v.policy.policy_version, status: 'draft', body: { ...v.policy, policy_version: draft_version }, actor: 'admin-key' });
        await repos.audit(q, a.tenant_id, 'admin-key', 'policy_draft', { draft_version });
      });
      return send(res, 200, { ok: true, errors: [], draft_version });
    }

    if (m === 'POST' && p === '/v1/replays') {
      const a = await auth(req, ['reader', 'admin']);
      const body = await readJson(req) as { kind?: string; decision_ids?: string[]; policy?: unknown };
      if (body?.kind !== 'policy_only') throw new HttpError(501, 'not_implemented', 'only kind "policy_only" in Gate A');
      const v = validatePolicy(body.policy);
      if (!v.ok) return send(res, 400, { ok: false, errors: v.errors });
      const ids = Array.isArray(body.decision_ids) ? body.decision_ids.slice(0, 500) : [];
      const policy: PolicyBody = { ...v.policy, policy_version: `${v.policy.policy_version}+replay-${randomUUID().slice(0, 8)}` };
      const results = [];
      for (const id of ids) {
        const orig = await repos.getDecision(d.db, a.tenant_id, id);
        if (!orig) { results.push({ decision_id: id, error: 'not_found' }); continue; }
        const snapshot = await repos.getSnapshot(d.db, a.tenant_id, orig.snapshot_id) as DecisionSnapshot | null;
        if (!snapshot) { results.push({ decision_id: id, error: 'snapshot_missing' }); continue; }
        const evaluation = orig.evaluation_id ? await repos.getEvaluation(d.db, a.tenant_id, orig.evaluation_id) as EvaluationRecord | null : null;
        // Reuses the stored snapshot, rule results and signals: zero judge calls (RFC §10).
        const replay: PolicyDecision = decide({ snapshot, rules: orig.rule_results, evaluation, policy, provenance: orig.provenance,
          decisionId: `dec-${randomUUID()}`, now: new Date().toISOString(), timings: { ingest_to_signal_ms: null, snapshot_ms: null, rules_ms: null, judge_http_rtt_ms: null, policy_ms: null } });
        await d.db.tx(q => repos.insertDecision(q, replay, orig.decision_id));
        results.push({ decision_id: id, before: { recommended: orig.recommended, decided_by: orig.decided_by, policy_version: orig.policy_version },
          after: { decision_id: replay.decision_id, recommended: replay.recommended, decided_by: replay.decided_by, policy_version: replay.policy_version, semantic: replay.semantic } });
      }
      return send(res, 200, { kind: 'policy_only', judge_calls: 0, policy_version: policy.policy_version, results });
    }

    if (m === 'POST' && p === '/v1/stream/tokens') {
      const a = await auth(req, ['reader', 'admin']);
      const token = randomBytes(24).toString('hex');
      streamTokens.set(token, { tenant_id: a.tenant_id, exp: Date.now() + 60_000 });
      return send(res, 200, { token, expires_in: 60 });
    }
    if (m === 'GET' && p === '/v1/stream') return stream(req, res, url);

    if (m === 'POST' && p === '/v1/sandbox/runs') {
      const a = await auth(req, ['admin']);
      const body = await readJson(req) as { scenario?: string };
      if (!body?.scenario || !d.sandboxScenarios.includes(body.scenario)) throw new HttpError(400, 'bad_scenario', `scenario must be one of ${d.sandboxScenarios.join(', ')}`);
      const recent = (sandboxRate.get(a.tenant_id) ?? []).filter(t => t > Date.now() - 60_000);
      if (recent.length >= 30) throw new HttpError(429, 'rate_limited', 'at most 30 sandbox runs per minute');
      sandboxRate.set(a.tenant_id, [...recent, Date.now()]);
      return send(res, 202, await d.startSandboxRun(a.tenant_id, body.scenario));
    }

    if (m === 'GET' && d.webRoot && !p.startsWith('/v1/')) return serveStatic(res, d.webRoot, p);
    throw new HttpError(404, 'not_found', 'no such route');
  }

  async function stream(req: IncomingMessage, res: ServerResponse, url: URL) {
    const tok = url.searchParams.get('token') ?? '';
    const t = streamTokens.get(tok);
    if (!t || t.exp < Date.now()) throw new HttpError(401, 'unauthenticated', 'invalid or expired stream token');
    streamTokens.delete(tok);  // single use
    let cursor = String(req.headers['last-event-id'] ?? url.searchParams.get('cursor') ?? '0');
    if (!/^\d+$/.test(cursor)) cursor = '0';
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': connected\n\n');
    let closed = false, pumping = false, again = false;
    const pump = async () => {
      if (pumping) { again = true; return; }
      pumping = true;
      try {
        do {
          again = false;
          for (;;) {
            const recs = await repos.readOutbox(d.db, t.tenant_id, cursor, 200);
            if (!recs.length || closed) break;
            for (const r of recs) { res.write(`id: ${r.cursor}\nevent: ${r.kind}\ndata: ${JSON.stringify(r)}\n\n`); cursor = r.cursor; }
          }
        } while (again && !closed);
      } finally { pumping = false; }
    };
    const unsub = d.subscribe(() => { void pump(); });
    const poll = setInterval(() => { void pump(); }, 1_000);          // outbox is the source of truth; notify is only a hint
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => { closed = true; unsub(); clearInterval(poll); clearInterval(ping); });
    await pump();
  }

  return createServer((req, res) => {
    handle(req, res).catch(e => {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof HttpError) return send(res, e.status, { error: { code: e.code, message: e.message } });
      console.error('api error:', (e as Error).message);   // never the request body or headers
      send(res, 500, { error: { code: 'internal', message: 'internal error' } });
    });
  });
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
async function serveStatic(res: ServerResponse, root: string, path: string) {
  const rel = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, rel);
  if (file !== root && !file.startsWith(root + sep)) throw new HttpError(403, 'forbidden', 'path');
  try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); } catch { throw new HttpError(404, 'not_found', 'no such file'); }
  const buf = await readFile(file).catch(() => null);
  if (!buf) throw new HttpError(404, 'not_found', 'no such file');
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(buf);
}
