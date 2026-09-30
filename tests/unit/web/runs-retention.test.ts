// Runs view retention (code review r1 of logs/2026-09-30_CONSOLE_UX_PLAN.md): the view keeps the newest 50 runs plus a
// manually selected older run, forgets the rest (late records are ignored), and labels its counts as that window.
import { test } from 'node:test';
import assert from 'node:assert/strict';

type El = { innerHTML: string; textContent: string; hidden: boolean; on: ((e: unknown) => void)[]; addEventListener(t: string, f: (e: unknown) => void): void };
const el = (): El => { const x: El = { innerHTML: '', textContent: '', hidden: false, on: [], addEventListener: (_t, f) => { x.on.push(f); } }; return x; };
const nodes: Record<string, El> = { '#runs': el(), '#run-rows': el(), '#runs-count': el(), '#runs-summary': el() };
(globalThis as any).document = { querySelector: (s: string) => nodes[s] ?? null };
// @ts-expect-error runs.js is a browser module without a declaration file
const { createRunsView } = await import('../../../web/js/runs.js');

const t0 = Date.parse('2026-09-30T00:00:00Z');
function feed(v: any, i: number, extra: Record<string, unknown>[] = []) {
  const run = `run-${i}`, at = new Date(t0 + i * 1000).toISOString();
  const ev = (id: string, boundary: string, more: Record<string, unknown> = {}) =>
    v.onRecord({ kind: 'event', payload: { run_id: run, event_id: id, boundary, received_at: at, producer_seq: Number(id.split('-').pop()), ...more } });
  ev(`${run}-e-1`, 'run_started', { attributes: { scenario: 'SOC1' }, task_goal: `goal ${i}` });
  ev(`${run}-e-2`, 'pre_tool', { tool: 'siem.search', operation_id: `${run}-op` });
  ev(`${run}-e-3`, 'post_tool', { tool: 'siem.search', operation_id: `${run}-op`, attributes: { receipt_status: 'executed', control_action: 'allow' } });
  for (const r of extra) v.onRecord(r);
}
const cards = () => (nodes['#runs'].innerHTML.match(/class="run-card"/g) ?? []).length;
const selected = () => nodes['#runs'].innerHTML.match(/data-run-id="([^"]+)"[^>]*data-selected/)?.[1] ?? null;
const calls = () => Number(nodes['#runs-summary'].innerHTML.match(/data-count="calls">(\d+)/)?.[1]);

test('51 runs: 50 cards, the newest selected, counts labelled as the window, evicted run not resurrected', () => {
  const v = createRunsView({ api: async () => ({ timeline: [] }), mode: () => 'gate', onDetails() {} })!;
  for (let i = 0; i < 51; i++) feed(v, i);
  v.render();
  assert.equal(cards(), 50);
  assert.equal(selected(), 'run-50');
  assert.equal(calls(), 50);
  assert.match(nodes['#runs-summary'].innerHTML, /counts cover the 50 most recent runs/);
  assert.equal(v.runIds().length, 50);
  // A late record for the evicted run is ignored rather than recreating a partial run.
  v.onRecord({ kind: 'event', payload: { run_id: 'run-0', event_id: 'run-0-e-4', boundary: 'run_finished', received_at: new Date(t0 + 99_000).toISOString(), producer_seq: 4 } });
  v.render();
  assert.ok(!v.runIds().includes('run-0'));
  v.reset();
});

test('a manually selected older run stays rendered and selected past the window', () => {
  for (const n of Object.values(nodes)) { n.innerHTML = ''; n.on = []; }
  const v = createRunsView({ api: async () => ({ timeline: [] }), mode: () => 'gate', onDetails() {} })!;
  for (let i = 0; i < 3; i++) feed(v, i);
  v.render();
  // The viewer clicks the oldest row.
  for (const f of nodes['#run-rows'].on) f({ target: { closest: () => ({ dataset: { runRow: 'run-0' } }) } });
  assert.equal(selected(), 'run-0');
  for (let i = 3; i < 60; i++) feed(v, i);
  v.render();
  assert.equal(selected(), 'run-0');
  assert.equal(cards(), 51);
  assert.equal(v.runIds().length, 51);
  assert.equal(calls(), 51);
  assert.match(nodes['#runs-summary'].innerHTML, /counts cover the 50 most recent runs plus the selected older run/);
  v.reset();
});

test('under 50 runs: no window label', () => {
  for (const n of Object.values(nodes)) { n.innerHTML = ''; n.on = []; }
  const v = createRunsView({ api: async () => ({ timeline: [] }), mode: () => 'gate', onDetails() {} })!;
  for (let i = 0; i < 5; i++) feed(v, i);
  v.render();
  assert.equal(cards(), 5);
  assert.doesNotMatch(nodes['#runs-summary'].innerHTML, /most recent runs/);
  v.reset();
});
