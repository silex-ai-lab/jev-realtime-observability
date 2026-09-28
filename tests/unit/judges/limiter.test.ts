import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket, monotonicMs } from '../../../server/judges/limiter.ts';

test('token bucket grants immediately when capacity is available', async () => {
  const b = new TokenBucket(100, 2);
  const t0 = monotonicMs();
  await b.acquire(1, t0 + 1000);
  await b.acquire(1, t0 + 1000);
  assert.ok(true);
});

test('token bucket rejects a waiter that exceeds its deadline', async () => {
  const b = new TokenBucket(0.01, 1);   // very slow refill; first token consumed, second waits
  await b.acquire(1, monotonicMs() + 1000);
  await assert.rejects(() => b.acquire(1, monotonicMs() + 30), /deadline/);
});
