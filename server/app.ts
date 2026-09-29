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
import { createControlVerifier } from '../sandbox/control.ts';
import { SCENARIOS, scenarioIds } from '../sandbox/scenarios/index.ts';
import { runScripted } from '../sandbox/drivers/scripted.ts';
import type { Provenance } from '../contracts/common.ts';

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
  /** Serve web/ (default true). */
  web?: boolean;
  /** Sandbox fault injection (F1's 1 ms judge budget). Default true: this app only runs sandbox tools; FAULT_INJECTION=0 disables it. */
  faultInjection?: boolean;
  /** Mirror sandbox runs as OTLP spans (default true). */
  mirrorOtlp?: boolean;
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
  close(): Promise<void>;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function createApp(opts: AppOptions): Promise<App> {
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
  const activePolicy = async (tenantId: string): Promise<PolicyBody> => {
    const cached = policies.get(tenantId);
    if (cached) return cached;
    const row = await repos.getActivePolicy(db, tenantId);
    const v = row ? validatePolicy(row.body) : { ok: true as const, policy: DEFAULT_POLICY };
    const p = v.ok ? v.policy : DEFAULT_POLICY;
    if (!row) await db.tx(q => repos.insertPolicyVersion(q, { policy_version: p.policy_version, tenant_id: tenantId, base_version: null, status: 'active', body: p, actor: 'bootstrap' })).catch(() => undefined);
    policies.set(tenantId, p);
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
    db, judge, authority, policy: activePolicy, provenance, verifier,
    leaseMs: opts.worker.leaseMs ?? 30_000, concurrency: opts.worker.concurrency ?? 2, onChange: notify,
  });

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
    preflight: gateMode ? { db, judge: gateJudge, authority, policy: activePolicy, faultInjection: opts.faultInjection ?? true } : null,
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
    async close() {
      if (verifierTimer) clearInterval(verifierTimer);
      await worker.stop();
      server.closeAllConnections();
      await new Promise<void>(res => server.close(() => res()));
      await db.close();
    },
  };
}
