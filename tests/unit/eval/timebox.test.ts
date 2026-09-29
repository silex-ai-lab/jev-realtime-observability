// eval/finetune/timebox.pl (batch 2 D5): the fine-tune's time box on machines without GNU timeout.
// Only the deadline may produce 124; a signal death must not look like success.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const box = (secs: number, cmd: string, env: Record<string, string> = {}) => {
  const t0 = Date.now();
  const r = spawnSync('perl', ['eval/finetune/timebox.pl', String(secs), 'sh', '-c', cmd], { env: { ...process.env, ...env } });
  return { code: r.status, ms: Date.now() - t0 };
};

test('success passes through as 0', () => assert.equal(box(5, 'exit 0').code, 0));
test('a non-zero exit passes through', () => assert.equal(box(5, 'exit 3').code, 3));
test('a signal death is 128+N, never 0 or 124', () => assert.equal(box(5, 'kill -TERM $$').code, 143));
test('the deadline gives 124 and stops the command', () => {
  const r = box(1, 'sleep 30');
  assert.equal(r.code, 124);
  assert.ok(r.ms < 5_000, `took ${r.ms} ms`);
});
test('a command that ignores TERM is killed after the grace period', () => {
  const r = box(1, "trap '' TERM; sleep 30", { TIMEBOX_GRACE: '1' });
  assert.equal(r.code, 124);
  assert.ok(r.ms < 6_000, `took ${r.ms} ms`);
});
