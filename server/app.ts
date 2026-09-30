// App factory (docs/CONTRACTS.md §4): storage, sandbox, judge, worker, API and UI in one process.
// Single replica by design (RFC §3): no HA claim.
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, migrate, type Db } from './storage/db.ts';
import * as repos from './storage/repos.ts';
import { createJudgeClient, type JudgeClient, type JudgeConfig } from './judges/index.ts';
import { createWorker, type Worker } from './worker/index.ts';
import { createApi } from './api/index.ts';
import { DEFAULT_POLICY, validatePolicy, type PolicyBody } from './policy/index.ts';
import { createAuthorityReader, createToolGateway, seedSandbox } from '../sandbox/index.ts';
import { createOutcomeVerifier, type OutcomeVerifier } from './outcomes/index.ts';
import { ensureActivePolicy } from './storage/policies.ts';
import { createControlVerifier } from '../sandbox/control.ts';
import { SCENARIOS, scenarioIds } from '../sandbox/scenarios/index.ts';
import { runScripted } from '../sandbox/drivers/scripted.ts';
import type { Provenance } from '../contracts/common.ts';
import { createOtlpDecisionExporter, type OtlpDecisionExporter } from './export/otlp.ts';

export interface TenantSetup {
  tenant_id: string;
  name: string;
  keys: { ingest: string; reader: string; gateway: string; admin: string };
}
export interface AppOptions {
  db?: Db;
  judge: JudgeConfig | null;
  /** Gate C: the judge used by /v1/preflight (default: judge). It must fit the 400 ms judge budget. */
  gateJudge?: JudgeConfig | null;
  sourceMode: 'live_sandbox_shadow' | 'live_sandbox_gate';
  tenants: TenantSetup[];
  worker: { autostart: boolean; leaseMs?: number; realtimeTtlMs?: number; concurrency?: number };
  port?: number;
  host?: string;
  /**
   * Authentication (default 'none'): 'keys' requires a tenant API key on every /v1 call; 'none' disables
   * login and acts as the first tenant with every role. 'none' is refused on a non-loopback host unless
   * allowUnauthenticatedRemote is set, because anyone reaching the port would have admin rights.
   */
  auth?: 'keys' | 'none';
  allowUnauthenticatedRemote?: boolean;
  /** Serve web/ (default true). */
  web?: boolean;
  /** Sandbox fault injection (F1's 1 ms judge budget). Default false: the fault drill is off unless the deployment enables it (FAULT_INJECTION=1). */
  faultInjection?: boolean;
  /** Test-only (docs/CONTRACTS.md §11.5): rule ids reported as PASS in this app instance; never read from the environment. */
  testDisabledRules?: string[];
  /** Mirror sandbox runs as OTLP spans (default true). */
  mirrorOtlp?: boolean;
  /** E1: OTLP decision-export URL (also `OTLP_EXPORT_URL`). Off (no outbound request) when unset. */
  otlpExportUrl?: string;
  /** E1: extra export headers (also `OTLP_EXPORT_HEADERS`, a JSON object). */
  otlpExportHeaders?: Record<string, string>;
  /** E1: bounded export queue size (also `OTLP_QUEUE_SIZE`). */
  otlpQueueSize?: number;
  /** E1: per-request export timeout in ms (also `OTLP_EXPORT_TIMEOUT_MS`). */
  otlpRequestTimeoutMs?: number;
  /** E1: export retries after the first attempt (also `OTLP_EXPORT_RETRIES`). */
  otlpRetries?: number;
}
export interface App {
  url: string;
  db: Db;
  judge: JudgeClient | null;
  worker: { drain(): Promise<void>; stop(): Promise<void> };
  /** Gate B: processes due outcome checks now; returns how many were processed. */
  outcomes: { tick(): Promise<number> };
  /** Starts a scripted sandbox run and resolves when the driver finished (evaluation continues async). */
  runScenario(tenantId: string, scenario: string): Promise<{ run_id: string; errors: string[] }>;
  /** E1: the decision exporter (null when export is off). Exposed for the drop-counter test. */
  otlp: OtlpDecisionExporter | null;
  /** The outbox → exporter feed (null when export is off): failures counted, never thrown. */
  otlpFeed: { errors(): number } | null;
  close(): Promise<void>;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

// Test hook: pause a policy cache fill between the DB read and the cache store. No-op unless a test
// installs it (policy-lifecycle.test.ts uses it to prove a delayed read cannot repopulate the cache
// with a stale policy after a concurrent switch).
let policyCacheFillHook: ((tenantId: string) => Promise<void>) | null = null;
export function setPolicyCacheFillHook(fn: ((tenantId: string) => Promise<void>) | null): void { policyCacheFillHook = fn; }

export async function createApp(opts: AppOptions): Promise<App> {
  const authMode = opts.auth ?? 'none';
  if (authMode === 'none' && !LOOPBACK.has(opts.host ?? '127.0.0.1') && !opts.allowUnauthenticatedRemote)
    throw new Error(`authentication is off (auth: 'none') but host is ${opts.host}: bind to 127.0.0.1, enable AUTH_MODE=keys, or set ALLOW_UNAUTHENTICATED_REMOTE=1 knowingly`);
  if (!opts.tenants.length) throw new Error('at least one tenant is required');
  const db = opts.db ?? await openDb();
  await migrate(db, [{ set: 'core', dir: join(ROOT, 'server/storage/migrations') }]);
  const internalKeys = new Map<string, string>();
  for (const t of opts.tenants) {
    await db.tx(async q => {
      await repos.ensureTenant(q, t.tenant_id, t.name);
      for (const role of ['ingest', 'reader', 'gateway', 'admin'] as const) {
        if (!(await repos.findApiKey(q, t.keys[role]))) await repos.createApiKey(q, t.tenant_id, role, `${role}-configured`, t.keys[role]);
      }
      // The in-process sandbox runner gets its own ingest key per process; it is never returned by the API.
      const k = randomBytes(24).toString('hex');
      await repos.createApiKey(q, t.tenant_id, 'ingest', 'sandbox-runner', k);
      internalKeys.set(t.tenant_id, k);
    });
    await seedSandbox(db, t.tenant_id);
  }

  const bus = new EventEmitter();
  bus.setMaxListeners(1000);
  const notify = () => { bus.emit('change'); };

  const judge = opts.judge ? createJudgeClient(opts.judge, { ledger: row => repos.insertJudgeCall(db, row) }) : null;
  if (judge) await judge.describe().catch(() => null);   // identity for provenance; failure leaves it null (readyz degraded)

  const policies = new Map<string, PolicyBody>();
  const policyGenerations = new Map<string, number>();

  const invalidatePolicy = (tenantId: string): void => {
    policyGenerations.set(tenantId, (policyGenerations.get(tenantId) ?? 0) + 1);
    policies.delete(tenantId);
  };

  const activePolicy = async (tenantId: string): Promise<PolicyBody> => {
    const cached = policies.get(tenantId);
    if (cached) return cached;
    const gen = policyGenerations.get(tenantId) ?? 0;
    const row = await db.tx(q => ensureActivePolicy(q, tenantId));
    const v = validatePolicy(row.body);
    const p = v.ok ? v.policy : DEFAULT_POLICY;
    if (policyCacheFillHook) await policyCacheFillHook(tenantId);
    if ((policyGenerations.get(tenantId) ?? 0) === gen) policies.set(tenantId, p);
    return p;
  };
  const provenance = (judgeSource: string | null): Provenance => ({
    source_mode: opts.sourceMode, judge_source: judgeSource, tool_environment: 'sandbox',
    enforcement_mode: opts.sourceMode === 'live_sandbox_gate' ? 'gate' : 'shadow',
  });

  const authority = createAuthorityReader(db);
  const gateMode = opts.sourceMode === 'live_sandbox_gate';
  // Gate mode: a control is mandatory for gated tools, and the gateway verifies it itself (CONTRACTS §9.2).
  const gateway = gateMode ? createToolGateway(db, { gate: true, requireControl: createControlVerifier(db) }) : createToolGateway(db);
  const gateJudge = gateMode
    ? (opts.gateJudge === undefined ? judge : opts.gateJudge ? createJudgeClient(opts.gateJudge, { ledger: row => repos.insertJudgeCall(db, row) }) : null)
    : null;
  if (gateJudge && gateJudge !== judge) await gateJudge.describe().catch(() => null);
  const verifier: OutcomeVerifier = createOutcomeVerifier(db, authority, {
    deadlineMs: { 'payments.execute': 10_000, 'email.send': 5_000 }, backoffMs: [250, 500, 1000, 2000],
  });
  const worker: Worker = createWorker({
    db, judge, authority, policy: activePolicy, provenance, verifier, faultInjection: opts.faultInjection ?? false, disabledRules: opts.testDisabledRules ?? [],
    leaseMs: opts.worker.leaseMs ?? 30_000, concurrency: opts.worker.concurrency ?? 2, onChange: notify,
  });

  // E1: OTLP export of decisions (docs/CONTRACTS.md §11.6). Off unless a URL is configured; every
  // committed decision is fed from the outbox after commit, never on the decision path.
  const otlpUrl = opts.otlpExportUrl ?? process.env.OTLP_EXPORT_URL ?? '';
  let otlp: OtlpDecisionExporter | null = null;
  let feedStopped = false, feedErrors = 0;
  let stopFeed: () => Promise<void> = async () => {};
  if (otlpUrl) {
    let envHeaders: Record<string, string> | undefined;
    if (process.env.OTLP_EXPORT_HEADERS) {
      try { envHeaders = JSON.parse(process.env.OTLP_EXPORT_HEADERS) as Record<string, string>; } catch { envHeaders = undefined; }
    }
    otlp = createOtlpDecisionExporter({
      url: otlpUrl,
      headers: opts.otlpExportHeaders ?? envHeaders,
      queueSize: opts.otlpQueueSize ?? (process.env.OTLP_QUEUE_SIZE ? Number(process.env.OTLP_QUEUE_SIZE) : undefined),
      requestTimeoutMs: opts.otlpRequestTimeoutMs ?? (process.env.OTLP_EXPORT_TIMEOUT_MS ? Number(process.env.OTLP_EXPORT_TIMEOUT_MS) : undefined),
      retries: opts.otlpRetries ?? (process.env.OTLP_EXPORT_RETRIES ? Number(process.env.OTLP_EXPORT_RETRIES) : undefined),
    });
    const cursorByTenant = new Map<string, string>();
    for (const t of opts.tenants) {
      const max = await db.query<{ m: string }>(`SELECT COALESCE(MAX(cursor), 0)::text AS m FROM outbox WHERE tenant_id = $1`, [t.tenant_id]);
      cursorByTenant.set(t.tenant_id, max.rows[0]?.m ?? '0');
    }
    // Feed decisions from the outbox to the exporter, off the decision path. Each tenant is drained page by page
    // until a short page, so a backlog never waits for a later notification. The cursor advances only after a
    // record was handled, so a failed read is retried (on the next change, or after a short delay). Failures stay
    // inside this feeder: they are counted and logged, and never reach decision processing or crash the process.
    const PAGE = 1000;
    let feedRun: Promise<void> | null = null;
    let dirty = false;
    let retryTimer: NodeJS.Timeout | null = null;
    const feedTenant = async (tenantId: string) => {
      for (;;) {
        const records = await repos.readOutbox(db, tenantId, cursorByTenant.get(tenantId) ?? '0', PAGE);
        for (const r of records) {
          if (feedStopped) return;
          if (r.kind === 'decision') {
            const payload = r.payload;
            const eventId = typeof payload.event_id === 'string' ? payload.event_id : '';
            const ev = eventId ? await repos.getEvent(db, tenantId, eventId) : null;
            // Gate mode binds a control to the operation at decision time; the receipt usually comes later (post_tool),
            // so receipt_status is present only when the receipt already exists at export time.
            const opId = ev?.operation?.operation_id ?? null;
            const ctl = opId ? (await db.query<{ action: string }>(`SELECT body->>'action' AS action FROM control_decisions WHERE tenant_id = $1 AND operation_id = $2`, [tenantId, opId])).rows[0] : undefined;
            const rc = opId ? (await db.query<{ status: string }>(`SELECT body->>'status' AS status FROM execution_receipts WHERE tenant_id = $1 AND operation_id = $2`, [tenantId, opId])).rows[0] : undefined;
            otlp!.export({ ...payload, control_action: ctl?.action ?? null, receipt_status: rc?.status ?? null });
          }
          cursorByTenant.set(tenantId, r.cursor);
        }
        if (records.length < PAGE) return;
      }
    };
    const feed = () => {
      if (feedStopped) return;
      if (feedRun) { dirty = true; return; }
      feedRun = (async () => {
        do {
          dirty = false;
          for (const t of opts.tenants) { if (feedStopped) return; await feedTenant(t.tenant_id); }
        } while (dirty && !feedStopped);
      })().catch(e => {
        feedErrors++;
        console.error('otlp export feed:', (e as Error).message);
        if (!feedStopped && !retryTimer) { retryTimer = setTimeout(() => { retryTimer = null; feed(); }, 1000); retryTimer.unref(); }
      }).finally(() => { feedRun = null; });
    };
    const onChange = () => feed();
    bus.on('change', onChange);
    stopFeed = async () => {
      feedStopped = true;
      bus.off('change', onChange);
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      await feedRun;
    };
    feed();
  }

  let baseUrl = '';
  const runScenario = async (tenantId: string, scenario: string) => {
    const sc = SCENARIOS.find(s => s.id === scenario);
    const key = internalKeys.get(tenantId);
    if (!sc || !key) throw new Error('unknown scenario or tenant');
    return runScripted({ baseUrl, ingestKey: key, tenantId, gateway, authority, mirrorOtlp: opts.mirrorOtlp ?? true, gate: gateMode }, sc);
  };

  const server = createApi({
    db, judge, realtimeTtlMs: opts.worker.realtimeTtlMs ?? DEFAULT_POLICY.realtime_ttl_ms,
    webRoot: opts.web === false ? null : join(ROOT, 'web'),
    activePolicy,
    invalidatePolicy,
    notify: () => { notify(); worker.wake(); },
    subscribe: fn => { bus.on('change', fn); return () => bus.off('change', fn); },
    startSandboxRun: async (tenantId, scenario) => {
      const sc = SCENARIOS.find(s => s.id === scenario)!;
      const runId = `run-${sc.id.toLowerCase()}-${randomBytes(4).toString('hex')}`;
      const key = internalKeys.get(tenantId)!;
      void runScripted({ baseUrl, ingestKey: key, tenantId, gateway, authority, mirrorOtlp: opts.mirrorOtlp ?? true, gate: gateMode }, sc, runId)
        .catch(e => console.error('sandbox run failed:', (e as Error).message));
      return { run_id: runId };
    },
    sandboxScenarios: scenarioIds(),
    authMode,
    defaultTenant: opts.tenants[0].tenant_id,
    preflight: gateMode ? { db, judge: gateJudge, authority, policy: activePolicy, faultInjection: opts.faultInjection ?? false, disabledRules: opts.testDisabledRules ?? [] } : null,
  });
  await new Promise<void>(res => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', res));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://${opts.host ?? '127.0.0.1'}:${addr.port}`;
  let verifierTimer: NodeJS.Timeout | null = null;
  if (opts.worker.autostart) {
    worker.start();
    let busy = false;
    verifierTimer = setInterval(() => {
      if (busy) return; busy = true;
      verifier.tick().then(n => { if (n) notify(); }).catch(e => console.error('outcome verifier:', (e as Error).message)).finally(() => { busy = false; });
    }, 250);
  }

  return {
    url: baseUrl,
    db,
    judge,
    worker: { drain: () => worker.drain(), stop: () => worker.stop() },
    outcomes: { tick: async () => { const n = await verifier.tick(); if (n) notify(); return n; } },
    runScenario,
    otlp,
    otlpFeed: otlp ? { errors: () => feedErrors } : null,
    async close() {
      if (verifierTimer) clearInterval(verifierTimer);
      await stopFeed();
      await worker.stop();
      server.closeAllConnections();
      await new Promise<void>(res => server.close(() => res()));
      if (otlp) await otlp.close();
      await db.close();
    },
  };
}
