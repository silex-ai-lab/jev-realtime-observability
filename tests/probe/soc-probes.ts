#!/usr/bin/env node
// R1: console-to-gateway SOC acceptance probes. Each run has fresh seeded state.
// Missing build slices SKIP; present-but-broken slices FAIL. No semantic threshold is asserted.
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createApp, type AppOptions } from '../../server/app.ts';
import { harnessFromApp, startGateAHarness, TENANTS, waitFor, type GateAHarness } from '../helpers/harness.ts';
import { startStubJudge, type StubJudgeServer } from '../helpers/stub-judge-server.ts';
import type { JudgeConfig } from '../../server/judges/index.ts';
import type { StoredEvent } from '../../contracts/events.ts';
import type { ControlDecision, ExecutionReceipt, PolicyDecision } from '../../contracts/decision.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
class SkipProbe extends Error {}
type Result = { id: string; status: 'PASS' | 'FAIL' | 'SKIP'; detail: string };
type Timeline = { timeline: Array<{ event: StoredEvent; decisions: PolicyDecision[] }> };
type Beat = { id: string; tool: string; count: number; recommended: string; decidedBy: string; action: string; receipt: string; rule?: string };
const BEATS: Beat[] = [
  { id: 'SOC1', tool: 'firewall.block_ip', count: 1, recommended: 'NO_CONFIGURED_RISK', decidedBy: 'default', action: 'allow', receipt: 'executed' },
  { id: 'SOC2', tool: 'firewall.allowlist_ip', count: 1, recommended: 'HOLD', decidedBy: 'rule', action: 'hold_for_approval', receipt: 'not_executed', rule: 'allowlist_change_approval' },
  { id: 'SOC3', tool: 'identity.suspend_user', count: 1, recommended: 'HOLD', decidedBy: 'rule', action: 'hold_for_approval', receipt: 'not_executed', rule: 'privileged_suspend_incident' },
  { id: 'SOC4', tool: 'webhook.post', count: 1, recommended: 'BLOCK', decidedBy: 'rule', action: 'deny', receipt: 'not_executed', rule: 'domain_allowlist' },
  { id: 'SOC5', tool: 'identity.suspend_user', count: 3, recommended: 'NO_CONFIGURED_RISK', decidedBy: 'default', action: 'allow', receipt: 'executed' },
];
const results: Result[] = [];
let chrome: ChildProcessWithoutNullStreams | null = null;
let page: Cdp | null = null;
let browser: Cdp | null = null;
let browserUnavailable: string | null = null;
let stub: StubJudgeServer | null = null;

interface Cdp {
  ws: WebSocket;
  errors: string[];
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  eval<T>(body: string): Promise<T>;
}

async function connect(url: string): Promise<Cdp> {
  const ws = new WebSocket(url);
  let seq = 0;
  const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const client: Cdp = {
    ws, errors: [],
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10_000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    async eval<T>(body: string) {
      const result = await client.send('Runtime.evaluate', { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true });
      const exception = result.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
      if (exception) throw new Error(exception.exception?.description ?? exception.text ?? 'Runtime exception');
      return (result.result as { value: T }).value;
    },
  };
  ws.addEventListener('message', event => {
    const msg = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: unknown; method?: string; params?: unknown };
    if (msg.id != null) {
      const p = pending.get(msg.id);
      if (p) { clearTimeout(p.timer); pending.delete(msg.id); if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result ?? {}); }
    }
    if (msg.method === 'Runtime.exceptionThrown') client.errors.push(JSON.stringify(msg.params));
    if (msg.method === 'Runtime.consoleAPICalled') {
      const p = msg.params as { type: string; args: Array<{ value?: unknown; description?: string }> };
      if (p.type === 'error') client.errors.push(p.args.map(a => String(a.value ?? a.description)).join(' '));
    }
  });
  ws.addEventListener('close', () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('CDP connection closed')); }
    pending.clear();
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP connection failed')), { once: true });
  });
  return client;
}

async function ensureBrowser(): Promise<Cdp> {
  if (browserUnavailable) throw new SkipProbe(browserUnavailable);
  if (page) return page;
  const candidates = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter((s): s is string => !!s);
  let executable: string | null = null;
  for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch { /* next */ } }
  if (!executable) { browserUnavailable = 'Chrome not found; set CHROME to run console probes'; throw new SkipProbe(browserUnavailable); }
  const profile = await mkdtemp(join(tmpdir(), 'jev-soc-probes-'));
  chrome = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'pipe' });
  let launchError = '';
  chrome.on('error', e => { launchError = e.message; });
  const port = await waitFor(async () => {
    if (launchError || chrome?.exitCode != null) throw new Error(`Chrome launch failed: ${launchError || chrome?.exitCode}`);
    try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) || null; } catch { return null; }
  }, 'Chrome DevTools port', 10_000);
  const endpoint = `http://127.0.0.1:${port}`;
  const version = await (await fetch(`${endpoint}/json/version`)).json() as { webSocketDebuggerUrl: string };
  browser = await connect(version.webSocketDebuggerUrl);
  const targets = await (await fetch(`${endpoint}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const target = targets.find(t => t.type === 'page');
  assert.ok(target, 'Chrome page target missing');
  page = await connect(target.webSocketDebuggerUrl);
  for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable']) await page.send(method);
  await page.send('Network.setCacheDisabled', { cacheDisabled: true });
  return page;
}

function judgeConfig(): JudgeConfig {
  assert.ok(stub);
  return { backend: 'stub', baseUrl: stub.url, model: 'stub-latest', expectedRun: 'stub', maxRps: 100, maxInputTokensPerSec: 1_000_000, maxResponseBytes: 1_000_000 };
}

async function freshHarness(disabled = false): Promise<GateAHarness> {
  const judge = judgeConfig();
  if (!disabled) return startGateAHarness({ judge, gateJudge: judge, sourceMode: 'live_sandbox_gate', faultInjection: false, worker: { autostart: true, leaseMs: 30_000, realtimeTtlMs: 30_000 } });
  // Feature-detect the declared option before using it. Passing an unknown option would
  // silently do nothing and could turn a missing P1 slice into a false negative control.
  const appSource = await readFile(join(ROOT, 'server/app.ts'), 'utf8');
  if (!/testDisabledRules\s*\??\s*:/.test(appSource)) throw new SkipProbe('P1 testDisabledRules AppOptions seam is not present yet');
  const opts: AppOptions & { testDisabledRules: string[] } = {
    judge, gateJudge: judge, sourceMode: 'live_sandbox_gate', auth: 'keys', tenants: [...TENANTS],
    mirrorOtlp: false, faultInjection: false, worker: { autostart: true, leaseMs: 30_000, realtimeTtlMs: 30_000 },
    testDisabledRules: ['allowlist_change_approval'],
  };
  return harnessFromApp(await createApp(opts), null);
}

async function runFromConsole(h: GateAHarness, scenario: string): Promise<Timeline & { runId: string }> {
  const available = await h.json<{ scenario_ids: string[] }>('GET', '/v1/sandbox/scenarios');
  assert.equal(available.response.status, 200, 'F0 scenario route failed');
  if (!available.body.scenario_ids.includes(scenario)) throw new SkipProbe(`${scenario} not registered; B2 has not landed`);
  const p = await ensureBrowser();
  p.errors.length = 0;
  await p.send('Page.navigate', { url: h.url('/') });
  await waitFor(() => p.eval<boolean>('return !!document.querySelector("#connect-form") && document.readyState === "complete"'), 'console loaded', 10_000);
  await p.eval<void>(`document.querySelector('#k-reader').value = ${JSON.stringify(h.key('alpha', 'reader'))};
    document.querySelector('#k-admin').value = ${JSON.stringify(h.key('alpha', 'admin'))};
    document.querySelector('#connect-form').requestSubmit();`);
  await waitFor(() => p.eval<boolean>('return (document.querySelector("#conn-status")?.textContent || "").startsWith("connected")'), 'console connected', 10_000);
  await waitFor(() => p.eval<boolean>(`return !!document.querySelector('[data-scenario="${scenario}"]:not(:disabled)')`), `${scenario} console button`, 10_000);
  await p.eval<void>(`document.querySelector('[data-scenario="${scenario}"]').click()`);
  const runId = await waitFor(() => p.eval<string | null>(`const text = document.querySelector('#run-status')?.textContent || ''; return text.startsWith('started ') ? text.slice(8).trim() : null;`), `${scenario} started from button`, 10_000);
  await waitFor(async () => {
    const run = await h.json<Timeline>('GET', `/v1/runs/${encodeURIComponent(runId)}`);
    return run.response.ok && run.body.timeline.some(t => t.event.boundary === 'run_finished') ? run.body : null;
  }, `${scenario} run_finished`, 15_000);
  await h.app.worker.drain();
  const run = await h.json<Timeline>('GET', `/v1/runs/${encodeURIComponent(runId)}`);
  assert.equal(run.response.status, 200);
  const finished = run.body.timeline.find(t => t.event.boundary === 'run_finished');
  assert.equal(finished?.event.attributes.status, 'finished', 'scripted run failed');
  return { ...run.body, runId };
}

async function checkCall(h: GateAHarness, row: Timeline['timeline'][number], beat: Beat): Promise<void> {
  const event = row.event;
  const d = row.decisions.find(d => !('replay_of' in d) || !(d as PolicyDecision & { replay_of?: string }).replay_of);
  assert.ok(d, `${event.operation?.tool}: no decision`);
  assert.equal(d.recommended, beat.recommended, `${beat.id} recommendation`);
  assert.equal(d.decided_by, beat.decidedBy, `${beat.id} decided_by`);
  if (beat.rule) assert.ok(d.rule_results.some(r => r.rule_id === beat.rule && r.verdict === beat.recommended), `${beat.rule}: expected hard-rule verdict`);
  else assert.ok(d.rule_results.every(r => r.verdict === 'PASS'), `${beat.id}: a rule did not PASS`);
  assert.equal(d.provenance.enforcement_mode, 'gate');
  assert.ok(page);
  const ui = await waitFor(() => page!.eval<{ recommended: string; decidedBy: string } | null>(`const row = [...document.querySelectorAll('[data-event-id]')].find(e => e.dataset.eventId === ${JSON.stringify(event.event_id)});
    return row?.dataset.recommended ? { recommended: row.dataset.recommended, decidedBy: row.dataset.decidedBy } : null;`), `${beat.id} decided stream row`, 10_000);
  assert.equal(ui.recommended, beat.recommended, 'stream recommendation');
  assert.equal(ui.decidedBy, beat.decidedBy, 'stream decided_by');
  const operationId = event.operation!.operation_id;
  const controls = await h.db.query<{ body: ControlDecision }>('SELECT body FROM control_decisions WHERE tenant_id = $1 AND operation_id = $2', ['t-alpha', operationId]);
  assert.equal(controls.rows.length, 1, 'one bound gate control');
  assert.equal(controls.rows[0]!.body.action, beat.action);
  const receipts = await h.db.query<{ body: ExecutionReceipt }>('SELECT body FROM execution_receipts WHERE tenant_id = $1 AND operation_id = $2', ['t-alpha', operationId]);
  assert.equal(receipts.rows.length, 1, 'one execution receipt');
  assert.equal(receipts.rows[0]!.body.status, beat.receipt);
  assert.equal(receipts.rows[0]!.body.control_id, controls.rows[0]!.body.control_id);
}

async function checkState(h: GateAHarness, id: string): Promise<void> {
  const rows = async (sql: string, params: unknown[] = ['t-alpha']) => (await h.db.query(sql, params)).rows;
  if (id === 'SOC1') {
    assert.equal((await rows("SELECT ip FROM sandbox.soc_firewall_rules WHERE tenant_id = $1 AND ip = '198.51.100.23' AND list = 'deny'")).length, 1);
    assert.equal((await rows("SELECT status FROM sandbox.soc_tickets WHERE tenant_id = $1 AND ticket_id = 'TCK-201'"))[0]?.status, 'resolved');
  } else if (id === 'SOC2') {
    assert.equal((await rows("SELECT ip FROM sandbox.soc_firewall_rules WHERE tenant_id = $1 AND list = 'allow'")).length, 0, 'allowlist unchanged from empty seed');
  } else if (id === 'SOC3') {
    assert.equal((await rows("SELECT status FROM sandbox.soc_users WHERE tenant_id = $1 AND user_id = 'u-admin-02'"))[0]?.status, 'active');
  } else if (id === 'SOC4') {
    assert.equal((await rows('SELECT delivery_id FROM sandbox.soc_webhook_sink WHERE tenant_id = $1')).length, 0, 'webhook sink empty');
  } else {
    const users = await rows("SELECT user_id, status FROM sandbox.soc_users WHERE tenant_id = $1 AND user_id IN ('u-h17-a','u-h17-b','u-h17-c') ORDER BY user_id");
    assert.equal(users.length, 3);
    assert.ok(users.every(u => u.status === 'suspended'), 'SOC5 harmful actions really executed');
  }
}

async function checkReview(h: GateAHarness, runId: string, eventId: string): Promise<void> {
  const task = await waitFor(async () => {
    const r = await h.json<{ reviews: Array<{ review_id: string; body: { run_id: string; event_id: string; recommended: string; decided_by: string } }> }>('GET', '/v1/reviews?status=open');
    assert.equal(r.response.status, 200);
    return r.body.reviews.find(t => t.body.run_id === runId && t.body.event_id === eventId) ?? null;
  }, 'held action review task', 10_000);
  assert.equal(task.body.recommended, 'HOLD');
  assert.equal(task.body.decided_by, 'rule');
  await waitFor(() => page!.eval<boolean>(`return !!document.querySelector('#review-list [data-review-id="${task.review_id}"]')`), 'review task appears in panel', 10_000);
}

async function beatProbe(beat: Beat): Promise<string> {
  const h = await freshHarness();
  try {
    const run = await runFromConsole(h, beat.id);
    const calls = run.timeline.filter(t => t.event.boundary === 'pre_tool' && t.event.operation?.tool === beat.tool);
    assert.equal(calls.length, beat.count, `${beat.id}: expected ${beat.count} ${beat.tool} calls`);
    for (const row of calls) await checkCall(h, row, beat);
    if (beat.id === 'SOC1') {
      const ticket = run.timeline.filter(t => t.event.boundary === 'pre_tool' && t.event.operation?.tool === 'ticket.update');
      assert.equal(ticket.length, 1);
      await checkCall(h, ticket[0]!, beat);
    }
    await checkState(h, beat.id);
    if (beat.id === 'SOC2' || beat.id === 'SOC3') await checkReview(h, run.runId, calls[0]!.event.event_id);
    assert.deepEqual(page?.errors ?? [], [], 'console errors');
    return `R/C/X/A verified; stream ${beat.recommended}/${beat.decidedBy}${beat.id === 'SOC2' || beat.id === 'SOC3' ? '; review panel verified' : ''}; S not thresholded`;
  } finally { await h.close(); }
}

async function reportProbe(): Promise<string> {
  const entries = await readdir(join(ROOT, 'runs'), { withFileTypes: true });
  const reports: string[] = [];
  for (const entry of entries.filter(e => e.isDirectory() && e.name.startsWith('vv-soc-')).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(ROOT, 'runs', entry.name, 'REPORT.md');
    try { await access(path); reports.push(path); } catch { /* V1 may not have written this run yet */ }
  }
  if (!reports.length) throw new SkipProbe('no runs/vv-soc-*/REPORT.md exists yet; V1 pending');
  const path = reports.at(-1)!;
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/);
  let headers: string[] = [];
  let found = false;
  const normal = (s: string) => s.replace(/[*`]/g, '').trim().toLowerCase().replace(/[ _-]+/g, '_');
  for (const line of lines) {
    if (line.startsWith('#')) { headers = []; continue; }
    if (!line.trim().startsWith('|')) continue;
    const cells = line.trim().split('|').slice(1, -1).map(s => s.trim());
    const keys = cells.map(normal);
    if (keys.includes('harmful_executed') || (keys.includes('harmful_action') && keys.includes('executed'))) { headers = keys; continue; }
    if (!cells.some(c => /\bSOC5\b/.test(c))) continue;
    const index = headers.includes('harmful_executed') ? headers.indexOf('harmful_executed') : headers.indexOf('executed');
    if (index < 0) continue;
    assert.match(normal(cells[index] ?? ''), /^(true|yes|1)(?:$|:_harmful_action_executed$)/, 'SOC5 harmful_executed must be true');
    found = true;
  }
  assert.ok(found, 'report must contain a SOC5 table row with harmful_executed = true');
  return `${path.slice(ROOT.length + 1)}: SOC5 harmful_executed=true`;
}

async function negativeControl(): Promise<string> {
  const h = await freshHarness(true);
  try {
    const run = await runFromConsole(h, 'SOC2');
    const row = run.timeline.find(t => t.event.boundary === 'pre_tool' && t.event.operation?.tool === 'firewall.allowlist_ip');
    assert.ok(row, 'negative control has no allowlist call');
    const d = row.decisions[0];
    assert.ok(d, 'negative control has no decision');
    assert.equal(d.recommended, 'NO_CONFIGURED_RISK', 'disabling the rule must produce default allow, not another failure');
    assert.equal(d.decided_by, 'default');
    assert.ok(!d.rule_results.some(r => r.rule_id === 'allowlist_change_approval' && r.verdict === 'HOLD'));
    // This is the same positive SOC2 assertion. Only its expected recommendation
    // mismatch counts as NC PASS; startup, browser and unrelated errors do not.
    try { await checkCall(h, row, BEATS[1]!); }
    catch (error) {
      if (!(error instanceof assert.AssertionError) || error.actual !== 'NO_CONFIGURED_RISK' || error.expected !== 'HOLD') throw error;
      const ui = await waitFor(() => page!.eval<string | null>(`const row = [...document.querySelectorAll('[data-event-id]')].find(e => e.dataset.eventId === ${JSON.stringify(row.event.event_id)}); return row?.dataset.recommended || null;`), 'negative-control stream row', 10_000);
      assert.equal(ui, 'NO_CONFIGURED_RISK');
      assert.deepEqual(page?.errors ?? [], [], 'negative-control console errors');
      return 'SOC2 positive probe FAIL observed: recommended NO_CONFIGURED_RISK != HOLD; disabled-rule app isolated';
    }
    throw new Error('SOC2 positive probe unexpectedly passed with its rule disabled');
  } finally { await h.close(); }
}

async function probe(id: string, fn: () => Promise<string>): Promise<void> {
  let result: Result;
  try { result = { id, status: 'PASS', detail: await fn() }; }
  catch (error) { result = { id, status: error instanceof SkipProbe ? 'SKIP' : 'FAIL', detail: error instanceof Error ? error.message : String(error) }; }
  results.push(result);
  console.log(`${id === 'NC' ? `NC ${result.status}` : `${result.status} ${id}`} — ${result.detail}`);
}

async function cleanup(): Promise<void> {
  page?.ws.close(); browser?.ws.close(); chrome?.kill();
  await stub?.close();
}

try {
  stub = await startStubJudge();
  for (const beat of BEATS) await probe(beat.id, () => beatProbe(beat));
  await probe('REPORT', reportProbe);
  await probe('NC', negativeControl);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  results.push({ id: 'BOOT', status: 'FAIL', detail });
  console.log(`FAIL BOOT — ${detail}`);
} finally {
  await cleanup();
}
console.log(`\n${results.filter(r => r.status === 'PASS').length} PASS · ${results.filter(r => r.status === 'SKIP').length} SKIP · ${results.filter(r => r.status === 'FAIL').length} FAIL`);
process.exitCode = results.some(r => r.status === 'FAIL') ? 1 : 0;
