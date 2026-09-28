import test from 'node:test';
import assert from 'node:assert/strict';
import { CANARY_JUDGE_API_KEY, assertNoCanary } from '../helpers/canary.ts';
import {
  collectStream,
  dumpAllTables,
  makeBoundaryEvent,
  postEventOk,
  runWorker,
  startGateAHarness,
  startStubJudge,
} from '../helpers/harness.ts';

const CANARY_FAILURES = [
  { name: 'http 500', response: { status: 500, body: { error: 'upstream failed' } } },
  { name: 'timeout', response: { status: 200, body: { model: 'kev-latest', answers: {} }, delayMs: 10_000 } },
  { name: 'invalid JSON', response: { status: 200, body: 'not-json' } },
] as const;

for (const scenario of CANARY_FAILURES) {
  test(`canary judge key is redacted through ${scenario.name}`, async () => {
    const captured: string[] = [];
    const originalError = console.error;
    const originalWarn = console.warn;
    const originalLog = console.log;
    console.error = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
    console.warn = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
    console.log = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };

    const judge = await startStubJudge({ respond: () => scenario.response });
    const h = await startGateAHarness({
      judge: {
        backend: 'stub',
        baseUrl: judge.url,
        apiKey: CANARY_JUDGE_API_KEY,
        model: 'kev-latest',
        expectedRun: 'stub-kev',
        maxRps: 100,
        maxInputTokensPerSec: 1_000_000,
        maxResponseBytes: 1_000_000,
      },
      worker: { autostart: true, leaseMs: 50, realtimeTtlMs: 500 },
    });
    try {
      const event = makeBoundaryEvent({ event_id: `evt-canary-${scenario.name.replaceAll(' ', '-')}` });
      await postEventOk(h, event);
      await runWorker(h);

      const runResponse = await h.request('GET', `/v1/runs/${encodeURIComponent(event.run_id)}`, { tenant: 'alpha', role: 'reader' });
      assertNoCanary(await runResponse.text(), 'run HTTP response');

      const readyz = await h.request('GET', '/readyz', { headers: {}, body: undefined });
      assertNoCanary(await readyz.text(), 'readyz HTTP response');

      const stream = await collectStream(h, 'alpha');
      assertNoCanary(stream, 'SSE payload');

      const dump = await dumpAllTables(h.db);
      assertNoCanary(dump, 'database dump');
      assertNoCanary(captured.join('\n'), 'console output');
    } finally {
      await h.close();
      await judge.close();
      console.error = originalError;
      console.warn = originalWarn;
      console.log = originalLog;
    }
  });
}
