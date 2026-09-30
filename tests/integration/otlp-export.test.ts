// E1: OTLP/HTTP export of decisions (docs/CONTRACTS.md §11.6). A local http server stands in for the
// collector. (a) attributes stay within the allowlist; (b) the canary token never leaves the process;
// (c) a hanging / 500 collector never blocks the decision path; (d) a full queue drops the oldest with
// a counter; (e) with no URL there is no exporter and no outbound request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { makeBoundaryEvent, startGateAHarness, startStubJudge, waitFor, type GateAHarness } from '../helpers/harness.ts';
import * as repos from '../../server/storage/repos.ts';
import { createOtlpDecisionExporter, EXPORT_ATTRIBUTE_KEYS } from '../../server/export/otlp.ts';

const T = 't-alpha';
const CANARY = 'CANARY-SESSION-7f3a91';
const ALLOWLIST = new Set<string>(EXPORT_ATTRIBUTE_KEYS);

interface Collector {
  url: string;
  bodies: string[];
  close(): Promise<void>;
}

function startCollector(mode: 'ok' | 'hang' | 'error'): Promise<Collector> {
  const bodies: string[] = [];
  const server: Server = createServer((req, res) => {
    res.on('error', () => {});
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      bodies.push(body);
      if (mode === 'ok') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }
      else if (mode === 'error') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"boom"}'); }
      // 'hang': never respond
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        bodies,
        close: () => new Promise<void>(res2 => { server.closeAllConnections?.(); server.close(() => res2()); }),
      });
    });
  });
}

/** Every span's attribute keys across all received request bodies. */
function spanKeys(bodies: string[]): string[][] {
  const out: string[][] = [];
  for (const b of bodies) {
    let parsed: { resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Array<{ attributes?: Array<{ key: string }> }> }> }> };
    try { parsed = JSON.parse(b); } catch { continue; }
    const spans = (parsed.resourceSpans ?? []).flatMap(rs => (rs.scopeSpans ?? []).flatMap(ss => ss.spans ?? []));
    for (const s of spans) out.push((s.attributes ?? []).map(a => a.key));
  }
  return out;
}

async function runSuite(h: GateAHarness): Promise<void> {
  for (const sc of ['SOC1', 'SOC2', 'SOC3', 'SOC4', 'SOC5']) {
    const r = await h.app.runScenario(T, sc);
    assert.deepEqual(r.errors, [], `${sc} driver errors`);
  }
  await h.app.worker.drain();
}

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  return fn().finally(() => {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
}

test('off by default: no URL means no exporter and no outbound request', async () => {
  await withEnv({ OTLP_EXPORT_URL: undefined, OTLP_EXPORT_HEADERS: undefined, OTLP_QUEUE_SIZE: undefined }, async () => {
    const h = await startGateAHarness({ judge: null, worker: { autostart: false, leaseMs: 30_000, realtimeTtlMs: 60_000 } });
    try {
      assert.equal(h.app.otlp, null, 'no exporter without a URL');
      await h.app.runScenario(T, 'SOC1');
      await h.app.worker.drain();
      const n = (await h.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM decisions WHERE tenant_id = $1`, [T])).rows[0].n;
      assert.ok(n >= 1, 'decisions still written with export off');
    } finally { await h.close(); }
  });
});

test('one span per decision, attributes within the allowlist, and the canary token never leaves', async () => {
  const collector = await startCollector('ok');
  await withEnv({ OTLP_EXPORT_URL: collector.url }, async () => {
    const h = await startGateAHarness({ judge: null, worker: { autostart: false, leaseMs: 30_000, realtimeTtlMs: 60_000 } });
    try {
      await runSuite(h);
      const decisionCount = (await h.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM decisions WHERE tenant_id = $1`, [T])).rows[0].n;
      await waitFor(async () => (spanKeys(collector.bodies).length >= decisionCount ? true : null), `all ${decisionCount} spans`, 10_000);
      await new Promise(r => setTimeout(r, 100));   // let any stragglers land before the leak check
      const keys = spanKeys(collector.bodies);
      assert.ok(keys.length >= decisionCount, `got ${keys.length} spans, expected >= ${decisionCount}`);
      for (const k of keys) {
        for (const key of k) assert.ok(ALLOWLIST.has(key), `attribute key outside the allowlist: ${key}`);
      }
      const everyByte = collector.bodies.join('');
      assert.ok(!everyByte.includes(CANARY), 'canary token leaked into an exported span');
    } finally { await h.close(); }
  });
  await collector.close();
});

test('a hanging collector and a 500 collector never block the decision path', async () => {
  for (const mode of ['hang', 'error'] as const) {
    const collector = await startCollector(mode);
    await withEnv({ OTLP_EXPORT_URL: collector.url, OTLP_EXPORT_TIMEOUT_MS: '150' }, async () => {
      const h = await startGateAHarness({ judge: null, worker: { autostart: false, leaseMs: 30_000, realtimeTtlMs: 60_000 } });
      try {
        await runSuite(h);
        const n = (await h.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM decisions WHERE tenant_id = $1`, [T])).rows[0].n;
        assert.ok(n >= 5, `decisions written despite a ${mode} collector (${n})`);
      } finally { await h.close(); }
    });
    await collector.close();
  }
});

test('the drop counter increases when the queue is full (small queue size)', async () => {
  const collector = await startCollector('hang');
  await withEnv({ OTLP_EXPORT_URL: collector.url, OTLP_QUEUE_SIZE: '1', OTLP_EXPORT_TIMEOUT_MS: '150' }, async () => {
    const h = await startGateAHarness({ judge: null, worker: { autostart: false, leaseMs: 30_000, realtimeTtlMs: 60_000 } });
    try {
      assert.ok(h.app.otlp, 'exporter on');
      await h.app.runScenario(T, 'SOC1');
      await h.app.worker.drain();
      await new Promise(r => setTimeout(r, 200));   // let the pump stay stuck so enqueues overflow
      assert.ok(h.app.otlp.dropped() >= 1, `drop counter moved (${h.app.otlp.dropped()})`);
      assert.ok(h.app.otlp.enqueued() >= 1, 'decisions were enqueued');
    } finally { await h.close(); }
  });
  await collector.close();
});

test('exporter drops the oldest pending span synchronously when full', async () => {
  const collector = await startCollector('hang');
  const exporter = createOtlpDecisionExporter({ url: collector.url, queueSize: 1, requestTimeoutMs: 100, retries: 0 });
  try {
    exporter.export({ decision_id: 'dec-a', run_id: 'run-1', event_id: 'ev-a', boundary: 'pre_tool', tool: 'x', recommended: 'NO_CONFIGURED_RISK', decided_by: 'default', policy_version: 'policy-a1' });
    exporter.export({ decision_id: 'dec-b', run_id: 'run-1', event_id: 'ev-b', boundary: 'pre_tool', tool: 'x', recommended: 'NO_CONFIGURED_RISK', decided_by: 'default', policy_version: 'policy-a1' });
    exporter.export({ decision_id: 'dec-c', run_id: 'run-1', event_id: 'ev-c', boundary: 'pre_tool', tool: 'x', recommended: 'NO_CONFIGURED_RISK', decided_by: 'default', policy_version: 'policy-a1' });
    assert.equal(exporter.enqueued(), 3);
    assert.ok(exporter.dropped() >= 1, `drop counter moved (${exporter.dropped()})`);
  } finally {
    await exporter.close();
    await collector.close();
  }
});

test('gate mode: every gated SOC decision span carries the bound control action, with the matching value', async () => {
  const collector = await startCollector('ok');
  const judge = await startStubJudge();
  const cfg = { backend: 'stub' as const, baseUrl: judge.url, model: 'kev-latest', expectedRun: 'stub', maxRps: 100, maxInputTokensPerSec: 1_000_000, maxResponseBytes: 1_000_000 };
  try { await withEnv({ OTLP_EXPORT_URL: collector.url }, async () => {
    const h = await startGateAHarness({ sourceMode: 'live_sandbox_gate', judge: cfg, gateJudge: cfg, worker: { autostart: false, leaseMs: 30_000, realtimeTtlMs: 60_000 } });
    try {
      await runSuite(h);
      const gated = (await h.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM control_decisions WHERE tenant_id = $1`, [T])).rows[0].n;
      const attrs = () => collector.bodies.flatMap(b => {
        try { return (JSON.parse(b).resourceSpans ?? []).flatMap((rs: any) => (rs.scopeSpans ?? []).flatMap((ss: any) => ss.spans ?? [])); } catch { return []; }
      }).map((sp: any) => Object.fromEntries((sp.attributes ?? []).map((a: any) => [a.key, a.value?.stringValue])));
      await waitFor(async () => (attrs().filter(a => a['silex.control_action']).length >= gated ? true : null), `${gated} spans with a control action`, 10_000);
      const byTool = attrs().filter(a => a['silex.control_action']);
      assert.ok(gated >= 9, `expected the nine gated SOC calls, got ${gated}`);
      assert.ok(byTool.some(a => a['silex.tool'] === 'firewall.allowlist_ip' && a['silex.control_action'] === 'hold_for_approval'));
      assert.ok(byTool.some(a => a['silex.tool'] === 'webhook.post' && a['silex.control_action'] === 'deny'));
      assert.ok(byTool.some(a => a['silex.tool'] === 'firewall.block_ip' && a['silex.control_action'] === 'allow'));
    } finally { await h.close(); }
  }); } finally { await judge.close(); await collector.close(); }
});

/** Every exported silex.decision_id across all received request bodies. */
function exportedDecisionIds(bodies: string[]): string[] {
  return bodies.flatMap(b => {
    try { return (JSON.parse(b).resourceSpans ?? []).flatMap((rs: any) => (rs.scopeSpans ?? []).flatMap((ss: any) => ss.spans ?? [])); } catch { return []; }
  }).map((sp: any) => (sp.attributes ?? []).find((a: any) => a.key === 'silex.decision_id')?.value?.stringValue).filter(Boolean);
}

test('a backlog larger than one outbox page is fully exported after a single notification, each decision exactly once', async () => {
  const collector = await startCollector('ok');
  try { await withEnv({ OTLP_EXPORT_URL: collector.url, OTLP_QUEUE_SIZE: '5000' }, async () => {
    const h = await startGateAHarness({ judge: null, worker: { autostart: false, leaseMs: 30_000, realtimeTtlMs: 60_000 } });
    try {
      const n = 1500;                                                    // more than the feeder's 1,000-record page
      await h.db.tx(async q => {
        for (let i = 0; i < n; i++) await repos.appendOutbox(q, { tenant_id: T, kind: 'decision', ref_id: `d-bl-${i}`, run_id: 'run-backlog',
          payload: { decision_id: `d-bl-${i}`, run_id: 'run-backlog', recommended: 'NO_CONFIGURED_RISK', decided_by: 'default', rule_results: [] } });
      });
      const res = await h.request('POST', '/v1/events', { tenant: 'alpha', role: 'ingest', body: makeBoundaryEvent() });   // exactly one change notification
      assert.equal(res.status, 202);
      await waitFor(async () => (exportedDecisionIds(collector.bodies).filter(id => id.startsWith('d-bl-')).length >= n ? true : null), `${n} backlog spans`, 20_000);
      await new Promise(r => setTimeout(r, 200));
      const ids = exportedDecisionIds(collector.bodies).filter(id => id.startsWith('d-bl-'));
      assert.equal(ids.length, n, 'each backlog decision exported exactly once');
      assert.equal(new Set(ids).size, n);
    } finally { await h.close(); }
  }); } finally { await collector.close(); }
});

test('an export-feed failure never crashes the process or touches decisions; the cursor is retried; close awaits the feed', async () => {
  const collector = await startCollector('ok');
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => { unhandled.push(e); };
  process.on('unhandledRejection', onUnhandled);
  try { await withEnv({ OTLP_EXPORT_URL: collector.url }, async () => {
    const h = await startGateAHarness({ judge: null, worker: { autostart: false, leaseMs: 30_000, realtimeTtlMs: 60_000 } });
    let closed = false;
    try {
      // Break a table only the feeder reads (shadow decisions never touch control_decisions).
      await h.db.query(`ALTER TABLE control_decisions RENAME TO control_decisions_broken`);
      const r = await h.app.runScenario(T, 'SOC1');
      assert.deepEqual(r.errors, []);
      await h.app.worker.drain();
      const decided = (await h.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM decisions d JOIN events e ON e.tenant_id = d.tenant_id AND e.event_id = d.event_id WHERE d.tenant_id = $1 AND e.run_id = $2`, [T, r.run_id])).rows[0].n;
      assert.ok(decided > 0, 'decisions were written while the feeder failed');
      await waitFor(async () => ((h.app.otlpFeed?.errors() ?? 0) > 0 ? true : null), 'a counted feed failure', 10_000);
      assert.equal(exportedDecisionIds(collector.bodies).length, 0, 'nothing exported past the failing record');
      // Repair: the feeder retries from its cursor and exports what it could not before.
      await h.db.query(`ALTER TABLE control_decisions_broken RENAME TO control_decisions`);
      await waitFor(async () => (exportedDecisionIds(collector.bodies).length >= decided ? true : null), `${decided} spans after repair`, 10_000);
      // Close while a feed may be in flight: close awaits it and nothing rejects afterwards.
      const res = await h.request('POST', '/v1/events', { tenant: 'alpha', role: 'ingest', body: makeBoundaryEvent() });
      assert.equal(res.status, 202);
      await h.close(); closed = true;
      await new Promise(r2 => setTimeout(r2, 300));
      assert.deepEqual(unhandled, []);
    } finally { if (!closed) await h.close(); }
  }); } finally { process.off('unhandledRejection', onUnhandled); await collector.close(); }
});
