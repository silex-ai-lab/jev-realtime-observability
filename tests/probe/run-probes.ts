#!/usr/bin/env node
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import assert from 'node:assert/strict';
import { findObjects, isObject, startGateAHarness, waitFor } from '../helpers/harness.ts';
import type { GateAHarness } from '../helpers/harness.ts';
import type { JudgeConfig } from '../../server/judges/index.ts';
import type { EvaluationRecord } from '../../contracts/judge.ts';

interface CdpClient {
  ws: WebSocket;
  errors: string[];
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  eval<T>(expression: string): Promise<T>;
}

interface ProbeResult {
  id: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
}

class SkipProbe extends Error {}

const results: ProbeResult[] = [];
const state: {
  chrome: ChildProcessWithoutNullStreams | null;
  browser: CdpClient | null;
  page: CdpClient | null;
  harness: GateAHarness | null;
  kevSignalEventId: string | null;
} = { chrome: null, browser: null, page: null, harness: null, kevSignalEventId: null };

async function main(): Promise<void> {
  const judge = judgeFromEnv();
  state.harness = await startGateAHarness({ judge, worker: { autostart: true, leaseMs: 30_000, realtimeTtlMs: 2_000 } });
  await seedLiveRun(state.harness);

  const profile = await mkdtemp(join(tmpdir(), 'jev-probes-'));
  state.chrome = spawn(await findChrome(), [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'pipe' });

  const port = await waitFor(async () => {
    try {
      return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
    } catch {
      return null;
    }
  }, 'Chrome DevTools port', 10_000);

  const endpoint = `http://127.0.0.1:${port}`;
  const version = await (await fetch(`${endpoint}/json/version`)).json() as { webSocketDebuggerUrl: string };
  state.browser = await connect(version.webSocketDebuggerUrl);
  const targets = await (await fetch(`${endpoint}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const target = targets.find(t => t.type === 'page');
  if (!target) throw new Error('Chrome page target not found');
  state.page = await connect(target.webSocketDebuggerUrl);
  for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable']) await state.page.send(method);
  await state.page.send('Network.setCacheDisabled', { cacheDisabled: true });

  await probe('P1', 'live UI shows four provenance dimensions', async () => {
    await navigate('/');
    const values = await pageEval<Record<string, string>>(`return Object.fromEntries(['source_mode','judge_source','tool_environment','enforcement_mode'].map(k => {
      const el = document.querySelector('[data-provenance="' + k + '"]');
      return [k, (el?.textContent || el?.getAttribute('data-value') || '').trim()];
    }))`);
    for (const [key, value] of Object.entries(values)) assert.ok(value, `missing provenance ${key}`);
    return JSON.stringify(values);
  });

  await probe('P2', 'Kev answers are not labelled Jev', async () => {
    if (!process.env.KEV_URL) throw new SkipProbe('set KEV_URL to require a live kev-local record');
    assert.ok(state.kevSignalEventId, 'seeded run did not produce a kev-local signal evaluation');
    await navigate('/');
    const targetEventId = state.kevSignalEventId;
    const found = await waitFor(() => pageEval<{ judge: string; signals: Array<{ source: string | null; text: string }> } | null>(`
      const targetEventId = ${JSON.stringify(targetEventId)};
      const row = [...document.querySelectorAll('[data-event-id]')].find(r => r.getAttribute('data-event-id') === targetEventId);
      row?.click();
      const judge = (document.querySelector('[data-provenance="judge_source"]')?.textContent || '').trim();
      const signals = [...document.querySelectorAll('[data-signal][data-judge-source]')]
        .map(e => ({ source: e.getAttribute('data-judge-source'), text: e.textContent || '' }))
        .filter(x => (x.source || '').startsWith('kev-local:'));
      if (judge.includes('kev-local:') && signals.length) return { judge, signals };
      return null;
    `), 'kev-local UI record', 60_000);
    assert.match(found.judge, /kev-local:/);
    for (const signal of found.signals) {
      assert.ok(signal.source?.startsWith('kev-local:'), `signal source is ${signal.source}`);
      assert.ok(!/\bJev\b/.test(signal.text), `Kev signal text is labelled Jev: ${signal.text}`);
    }
    return `${found.signals.length} kev-local signal(s) checked; judge chip ${found.judge}`;
  });

  await probe('P3', 'absent baselines render not measured', async () => {
    await navigate('/');
    const statuses = await pageEval<Array<{ key: string | null; text: string }>>(`return [...document.querySelectorAll('[data-baseline-status]')].map(e => ({ key: e.getAttribute('data-baseline-status'), text: (e.textContent || '').trim().toLowerCase() }))`);
    assert.ok(statuses.length, 'no baseline status hooks found');
    const absent = statuses.filter(s => s.key === 'B1' || s.key === 'B3' || /b1|b3|llm|slow/i.test(s.text));
    assert.ok(absent.length, 'no absent baseline rows found');
    assert.ok(absent.every(s => s.text.includes('not measured')), JSON.stringify(absent));
    return JSON.stringify(absent);
  });

  await probe('P4', 'no JavaScript errors', async () => {
    await navigate('/');
    assert.deepEqual(state.page?.errors ?? [], []);
    return 'console clean';
  });

  await probe('P5', '390px viewport has no horizontal scroll', async () => {
    if (!state.page) throw new Error('page not connected');
    await state.page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
    await navigate('/');
    const width = await pageEval<{ inner: number; scroll: number }>('return { inner: window.innerWidth, scroll: document.documentElement.scrollWidth }');
    assert.ok(width.scroll <= width.inner + 1, JSON.stringify(width));
    return JSON.stringify(width);
  });
}

async function seedLiveRun(h: GateAHarness): Promise<void> {
  const scenario = process.env.KEV_URL ? 'S2' : 'S1';
  const { response, body } = await h.json<{ run_id?: string }>('POST', '/v1/sandbox/runs', {
    tenant: 'alpha',
    role: 'admin',
    body: { scenario },
  });
  if (response.status !== 202) return;
  await h.app.worker.drain();
  if (!process.env.KEV_URL || !body.run_id) return;
  const runId = body.run_id;
  const kevSignal = await waitFor(async () => {
    const run = await h.json('GET', `/v1/runs/${encodeURIComponent(runId)}`, { tenant: 'alpha', role: 'reader' });
    const evaluations = findObjects<EvaluationRecord>(
      run.body,
      v => isObject(v) && typeof v.evaluation_id === 'string' && typeof v.event_id === 'string' && isObject(v.signals),
    );
    return evaluations.find(e => e.judge_source?.startsWith('kev-local:') && Object.keys(e.signals).length) ?? null;
  }, 'seeded kev-local signal evaluation', 60_000);
  state.kevSignalEventId = kevSignal?.event_id ?? null;
}

function judgeFromEnv(): JudgeConfig | null {
  if (!process.env.KEV_URL) return null;
  return {
    backend: 'kev-local',
    baseUrl: process.env.KEV_URL,
    model: 'kev-latest',
    expectedRun: 'jaredpalmer/kev-4b',
    maxRps: 10,
    maxInputTokensPerSec: 1_000_000,
    maxResponseBytes: 1_000_000,
  };
}

async function findChrome(): Promise<string> {
  const candidates = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter((v): v is string => !!v);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new Error('Chrome not found; set CHROME');
}

async function connect(url: string): Promise<CdpClient> {
  const ws = new WebSocket(url);
  const waiting = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }>();
  let seq = 0;
  const client: CdpClient = {
    ws,
    errors: [],
    send(method: string, params: Record<string, unknown> = {}) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }, 30_000);
        waiting.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    async eval<T>(expression: string) {
      const result = await client.send('Runtime.evaluate', { expression: `(async()=>{${expression}})()`, awaitPromise: true, returnByValue: true });
      const exception = result.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
      if (exception) throw new Error(exception.exception?.description ?? exception.text ?? 'Runtime exception');
      const wrapped = result.result as { value?: T } | undefined;
      return wrapped?.value as T;
    },
  };
  ws.addEventListener('message', event => {
    const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
    if (typeof msg.id === 'number') {
      const pending = waiting.get(msg.id);
      if (pending) {
        waiting.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
        else pending.resolve((msg.result ?? {}) as Record<string, unknown>);
      }
    }
    if (msg.method === 'Runtime.exceptionThrown') client.errors.push(JSON.stringify(msg.params));
    if (msg.method === 'Runtime.consoleAPICalled') {
      const params = msg.params as { type?: string; args?: Array<{ value?: unknown; description?: string }> };
      if (params.type === 'error') client.errors.push((params.args ?? []).map(a => String(a.value ?? a.description)).join(' '));
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket open failed')), { once: true });
  });
  return client;
}

async function navigate(path: string): Promise<void> {
  if (!state.page || !state.harness) throw new Error('probe not initialised');
  await state.page.send('Page.navigate', { url: state.harness.url(path) });
  await waitFor(() => pageEval<boolean>('return document.readyState === "complete"'), `navigate ${path}`, 15_000);
  await connectUi();
  await new Promise(resolve => setTimeout(resolve, 200));
}

async function connectUi(): Promise<void> {
  if (!state.harness) throw new Error('probe not initialised');
  await waitFor(() => pageEval<boolean>('return !!document.querySelector("#connect-form")'), 'connect form', 10_000);
  const reader = state.harness.key('alpha', 'reader');
  const admin = state.harness.key('alpha', 'admin');
  await pageEval<void>(`
    document.querySelector('#k-reader').value = ${JSON.stringify(reader)};
    document.querySelector('#k-admin').value = ${JSON.stringify(admin)};
    document.querySelector('#connect-form').requestSubmit();
  `);
  await waitFor(() => pageEval<boolean>('return /connected/i.test(document.querySelector("#conn-status")?.textContent || "")'), 'live UI connection', 10_000);
}

async function pageEval<T>(expression: string): Promise<T> {
  if (!state.page) throw new Error('page not connected');
  return state.page.eval<T>(expression);
}

async function probe(id: string, name: string, fn: () => Promise<string>): Promise<void> {
  let status: ProbeResult['status'] = 'PASS';
  let detail = '';
  try {
    detail = await fn();
  } catch (error) {
    status = error instanceof SkipProbe ? 'SKIP' : 'FAIL';
    detail = error instanceof Error ? error.message : String(error);
  }
  if (status !== 'SKIP' && state.page?.errors.length) {
    status = 'FAIL';
    detail = `${detail} console: ${state.page.errors.slice(0, 3).join(' / ')}`.trim();
  }
  results.push({ id, status, detail });
  console.log(`${status} ${id} ${name} — ${detail}`);
}

try {
  await main();
} catch (error) {
  results.push({ id: 'BOOT', status: 'FAIL', detail: error instanceof Error ? error.stack ?? error.message : String(error) });
  console.log(`FAIL BOOT probe startup — ${results.at(-1)?.detail}`);
} finally {
  state.page?.ws.close();
  state.browser?.ws.close();
  state.chrome?.kill();
  if (state.harness) await state.harness.close();
}

const pass = results.filter(r => r.status === 'PASS').length;
const skip = results.filter(r => r.status === 'SKIP').length;
const fail = results.filter(r => r.status === 'FAIL').length;
console.log(`\n${pass}/${results.length} PASS · ${skip} SKIP · ${fail} FAIL`);
process.exitCode = results.length === 0 || fail ? 1 : 0;
