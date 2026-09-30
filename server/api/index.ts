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
import { HttpError, readJson, send, type AuthFn, type Role } from './http.ts';
import * as policyRoutes from './policies.ts';
import * as reviewRoutes from './reviews.ts';
import type { PolicyDecision } from '../../contracts/decision.ts';
import type { DecisionSnapshot } from '../../contracts/snapshot.ts';
import { RUBRIC } from '../state/index.ts';
import { computeMetrics } from './metrics.ts';
import { preflight, PreflightError, type PreflightDeps } from './preflight.ts';

export interface ApiDeps {
  db: Db;
  judge: JudgeClient | null;
  realtimeTtlMs: number;
  webRoot: string | null;
  activePolicy: (tenantId: string) => Promise<PolicyBody>;
  /** Drops the tenant's cached active policy; policy lifecycle routes call it after commit. */
  invalidatePolicy: (tenantId: string) => void;
  notify: () => void;
  subscribe: (fn: () => void) => () => void;
  startSandboxRun: (tenantId: string, scenario: string) => Promise<{ run_id: string }>;
  sandboxScenarios: string[];
  /** Scenario metadata for the Runs view picker: {id, title, domain} in the same order as sandboxScenarios. */
  sandboxScenarioMeta: Array<{ id: string; title: string; domain: string }>;
  /** Tool impact by name, from rubrics/rubric-manifest.v1.json tool_registry. */
  toolImpacts: Record<string, string>;
  /** Impact assumed for tools not in the registry (unknown_tool_impact). */
  unknownToolImpact: string;
  /** The deployment's source mode, so the console can say which mode it is in before the first decision. */
  sourceMode: string;
  /**
   * 'keys' (opt-in): every /v1 call needs a tenant API key with the right role.
   * 'none' (default): no login; every call acts as `defaultTenant` with every role. Only safe on a
   * loopback address; createApp refuses a non-loopback host in this mode unless explicitly allowed.
   */
  authMode: 'keys' | 'none';
  defaultTenant: string;
  /** Gate C: synchronous preflight dependencies (null when the app runs in shadow mode). */
  preflight: PreflightDeps | null;
}

export function createApi(d: ApiDeps): Server {
  const streamTokens = new Map<string, { tenant_id: string; exp: number }>();
  const sandboxRate = new Map<string, number[]>();

  const auth: AuthFn = async (req, roles) => {
    if (d.authMode === 'none') return { tenant_id: d.defaultTenant, role: roles[0] };
    const h = req.headers.authorization ?? '';
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) throw new HttpError(401, 'unauthenticated', 'missing bearer key');
    const k = await repos.findApiKey(d.db, m[1]);
    if (!k) throw new HttpError(401, 'unauthenticated', 'unknown key');
    if (!roles.includes(k.role as Role)) throw new HttpError(403, 'forbidden', 'role not allowed');
    return { tenant_id: k.tenant_id, role: k.role as Role };
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://local');
    const p = url.pathname, m = req.method ?? 'GET';

    if (m === 'GET' && p === '/healthz') return send(res, 200, { ok: true });
    if (m === 'GET' && p === '/v1/auth') return send(res, 200, { mode: d.authMode });
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

    if (await policyRoutes.handle(d, auth, req, res, url)) return;
    if (await reviewRoutes.handle(d, auth, req, res, url)) return;

    if (m === 'POST' && p === '/v1/preflight') {
      const a = await auth(req, ['ingest']);
      if (!d.preflight) throw new HttpError(409, 'not_gate_mode', 'this deployment runs in shadow mode; preflight is disabled');
      try { return send(res, 200, await preflight(d.preflight, a.tenant_id, await readJson(req))); }
      catch (e) { if (e instanceof PreflightError) throw new HttpError(e.status, 'preflight_rejected', e.message); throw e; }
    }
    const revokeMatch = /^\/v1\/controls\/([A-Za-z0-9._:~\-]+)\/revoke$/.exec(p);
    if (m === 'POST' && revokeMatch) {
      const a = await auth(req, ['admin']);
      const r = await d.db.query<{ control_id: string }>(`UPDATE control_decisions SET revoked_at = now() WHERE tenant_id = $1 AND control_id = $2 AND revoked_at IS NULL RETURNING control_id`, [a.tenant_id, revokeMatch[1]]);
      if (!r.rows.length) throw new HttpError(404, 'not_found', 'control not found or already revoked');
      await repos.audit(d.db, a.tenant_id, 'admin-key', 'control_revoked', { control_id: revokeMatch[1] });
      return send(res, 200, { control_id: revokeMatch[1], revoked: true });
    }

    if (m === 'GET' && p === '/v1/metrics') {
      const a = await auth(req, ['reader', 'admin']);
      return send(res, 200, await computeMetrics(d.db, a.tenant_id, url.searchParams.get('run_id')));
    }

    if (m === 'POST' && p === '/v1/replays') {
      const a = await auth(req, ['reader', 'admin']);
      const body = await readJson(req) as { kind?: string; decision_ids?: string[]; policy?: unknown; run_id?: string };
      if (body?.kind === 'model_reeval') return send(res, 200, await modelReeval(a.tenant_id, body.decision_ids));
      if (body?.kind === 'sandbox_reexec') {
        if (a.role !== 'admin') throw new HttpError(403, 'forbidden', 'sandbox re-execution needs the admin role');
        return send(res, 202, await sandboxReexec(a.tenant_id, body.run_id));
      }
      if (body?.kind !== 'policy_only') throw new HttpError(400, 'bad_kind', 'kind must be policy_only, model_reeval or sandbox_reexec');
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

    if (m === 'GET' && p === '/v1/sandbox/scenarios') {
      await auth(req, ['reader', 'admin']);
      return send(res, 200, { scenario_ids: d.sandboxScenarios, scenarios: d.sandboxScenarioMeta, tools: d.toolImpacts, unknown_tool_impact: d.unknownToolImpact, source_mode: d.sourceMode });
    }

    if (m === 'POST' && p === '/v1/sandbox/runs') {
      const a = await auth(req, ['admin']);
      const body = await readJson(req) as { scenario?: string };
      if (!body?.scenario || !d.sandboxScenarios.includes(body.scenario)) throw new HttpError(400, 'bad_scenario', `scenario must be one of ${d.sandboxScenarios.join(', ')}`);
      takeSandboxSlot(a.tenant_id);
      return send(res, 202, await d.startSandboxRun(a.tenant_id, body.scenario));
    }

    // Run again (plan r7 C2'): its own admin route, so it also works with login off (the /v1/replays
    // reader path resolves login-off callers to the reader role and would 403). Same logic as
    // /v1/replays kind sandbox_reexec, which is kept for compatibility.
    if (m === 'POST' && p === '/v1/sandbox/reexec') {
      const a = await auth(req, ['admin']);
      const body = await readJson(req) as { run_id?: string };
      takeSandboxSlot(a.tenant_id);   // a re-run starts a sandbox run, so it shares the 30/min budget
      return send(res, 202, await sandboxReexec(a.tenant_id, body.run_id));
    }

    if (m === 'GET' && d.webRoot && !p.startsWith('/v1/')) return serveStatic(res, d.webRoot, p);
    throw new HttpError(404, 'not_found', 'no such route');
  }

  function takeSandboxSlot(tenantId: string) {
    const recent = (sandboxRate.get(tenantId) ?? []).filter(t => t > Date.now() - 60_000);
    if (recent.length >= 30) throw new HttpError(429, 'rate_limited', 'at most 30 sandbox runs per minute');
    sandboxRate.set(tenantId, [...recent, Date.now()]);
  }

  /** Starts a NEW run of the same scripted scenario: new run id, new operation ids; the original run is untouched (RFC §10). */
  async function sandboxReexec(tenantId: string, runId: string | undefined) {
    const runs = await repos.listRuns(d.db, tenantId, 500) as Array<{ run_id: string; scenario: string | null }>;
    const run = runs.find(r => r.run_id === runId);
    if (!run) throw new HttpError(404, 'not_found', 'run not found');
    if (!run.scenario || !d.sandboxScenarios.includes(run.scenario)) throw new HttpError(400, 'not_reexecutable', 'only scripted sandbox runs can be re-executed');
    const started = await d.startSandboxRun(tenantId, run.scenario);
    return { kind: 'sandbox_reexec', of_run_id: run.run_id, run_id: started.run_id };
  }

  /** Re-asks the judge on the stored snapshot (same judge view, same questions). New evaluation + new decision; originals untouched. */
  async function modelReeval(tenantId: string, ids: string[] | undefined) {
    const list = Array.isArray(ids) ? ids : [];
    if (!list.length || list.length > 20) throw new HttpError(400, 'bad_batch', '1..20 decision_ids (each re-evaluation is a real, budgeted model call)');
    if (!d.judge) throw new HttpError(409, 'judge_not_configured', 'no judge configured');
    const policy = await d.activePolicy(tenantId);
    const results = [];
    let attempts = 0;
    for (const id of list) {
      const orig = await repos.getDecision(d.db, tenantId, id);
      if (!orig) { results.push({ decision_id: id, error: 'not_found' }); continue; }
      const snapshot = await repos.getSnapshot(d.db, tenantId, orig.snapshot_id) as DecisionSnapshot | null;
      const prior = (await repos.listEvaluationsForEvent(d.db, tenantId, orig.event_id)).find(e => e.question_ids.length);
      if (!snapshot || !prior) { results.push({ decision_id: id, error: 'no_judge_questions_for_this_decision' }); continue; }
      const evaluationId = `eval-${randomUUID()}`;
      const startedAt = new Date().toISOString();
      const req = { model: d.judge.config.model, state: snapshot.judge_view.state, questions: Object.fromEntries(prior.question_ids.map(q => [q, RUBRIC.questions[q]])) };
      const r = await d.judge.call(req, prior.required_question_ids, { tenantId, evaluationId, caller: 'model_reeval', deadlineMs: policy.judge_deadline_ms * 3, retry429: true });
      attempts += r.attempts;
      const evaluation: EvaluationRecord = {
        evaluation_id: evaluationId, tenant_id: tenantId, event_id: orig.event_id, snapshot_id: snapshot.snapshot_id, kind: 'model_reeval',
        rubric_id: RUBRIC.rubric_id, question_ids: prior.question_ids, required_question_ids: prior.required_question_ids,
        judge_source: r.served_model ? judgeSourceOf(r.served_model) : null, served_model: r.served_model, request_hash: r.request_hash,
        client_request_id: r.client_request_id, vendor_request_id: r.vendor_request_id, status: r.status, http_status: r.http_status, attempts: r.attempts,
        judge_http_rtt_ms: r.judge_http_rtt_ms, vendor_latency_ms: r.vendor_latency_ms, usage: r.usage, billing: r.billing, signals: r.signals, errors: r.errors,
        started_at: startedAt, finished_at: new Date().toISOString(),
      };
      const replay = decide({ snapshot, rules: orig.rule_results, evaluation, policy: { ...policy, policy_version: `${policy.policy_version}+model-reeval` },
        provenance: { ...orig.provenance, judge_source: evaluation.judge_source }, decisionId: `dec-${randomUUID()}`, now: new Date().toISOString(),
        timings: { ingest_to_signal_ms: null, snapshot_ms: null, rules_ms: null, judge_http_rtt_ms: r.judge_http_rtt_ms, policy_ms: null } });
      await d.db.tx(async q => { await repos.insertEvaluation(q, evaluation); await repos.insertDecision(q, replay, orig.decision_id); });
      results.push({ decision_id: id, before: { recommended: orig.recommended, evaluation_id: orig.evaluation_id ?? prior.evaluation_id },
        after: { decision_id: replay.decision_id, recommended: replay.recommended, evaluation_id: evaluationId, status: evaluation.status, signals: evaluation.signals } });
    }
    // Reported from actual outbound attempts: a model_mismatch or not-sent call counts as 0.
    return { kind: 'model_reeval', judge_calls: attempts, results };
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
