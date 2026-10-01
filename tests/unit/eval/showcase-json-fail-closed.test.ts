// Fail-closed generator: showcase-json.ts must throw (not silently drop) on malformed or
// inconsistent goal_deviation/test predictions. Small fixtures are built in a temp dir,
// never under runs/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const THRESHOLD: Record<string, number> = { 'kev-0.8b': 0.6, 'kev-0.8b-ft': 0.01, 'kev-4b': 0.47, 'kev-4b-ft': 0.01 };
const IDS = ['item-a', 'item-b']; // item-a positive, item-b negative

function pred(itemId: string, label: boolean, p: number, status = 'ok') {
  return { item_id: itemId, question_id: 'goal_deviation', split: 'test', label, status, signal: { type: 'noul', raw_probability: p } };
}
const validRows = (): Record<string, object[]> => Object.fromEntries(Object.keys(THRESHOLD).map(l => [l, [pred(IDS[0], true, 0.8), pred(IDS[1], false, 0.1)]]));

function writeFixture(rowsByLabel: Record<string, object[]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'jev-gate-fail-'));
  const summary: Record<string, unknown> = {};
  for (const [label, threshold] of Object.entries(THRESHOLD)) summary[label] = { 'goal_deviation/test': { threshold } };
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary));
  for (const [label, rows] of Object.entries(rowsByLabel)) writeFileSync(join(dir, `predictions-${label}.jsonl`), rows.map(r => JSON.stringify(r) + '\n').join(''));
  return dir;
}

function runGenerator(dir: string): string {
  try {
    execFileSync(process.execPath, ['eval/run/showcase-json.ts', '--out', dir, '--ft', join(dir, 'ft0'), '--ft4b', join(dir, 'ft4b'), '--json', join(dir, 'out.json')], { stdio: 'pipe' });
  } catch (e) {
    const err = e as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    return String(err.stderr ?? err.stdout ?? err.message ?? e);
  }
  throw new Error('expected the generator to fail');
}

test('throws on a duplicate item_id in one prediction file', () => {
  const rows = validRows();
  rows['kev-0.8b'] = [pred(IDS[0], true, 0.8), pred(IDS[0], true, 0.9), pred(IDS[1], false, 0.1)];
  assert.match(runGenerator(writeFixture(rows)), /duplicate item_id "item-a"/);
});

test('throws on a non-ok status', () => {
  const rows = validRows();
  rows['kev-0.8b'] = [pred(IDS[0], true, 0.8, 'timeout'), pred(IDS[1], false, 0.1)];
  assert.match(runGenerator(writeFixture(rows)), /status "timeout"/);
});

test('throws on a partial status (only ok is accepted)', () => {
  const rows = validRows();
  rows['kev-0.8b'] = [pred(IDS[0], true, 0.8, 'partial'), pred(IDS[1], false, 0.1)];
  assert.match(runGenerator(writeFixture(rows)), /status "partial"/);
});

test('throws on a missing or non-finite noul raw_probability', () => {
  const rows = validRows();
  rows['kev-0.8b'] = [pred(IDS[0], true, 0.8), { ...pred(IDS[1], false, 0.1), signal: null }];
  assert.match(runGenerator(writeFixture(rows)), /no finite noul raw_probability/);
});

test('throws when the challenger file is missing an item the champion has', () => {
  const rows = validRows();
  rows['kev-0.8b-ft'] = [pred(IDS[0], true, 0.9)];
  assert.match(runGenerator(writeFixture(rows)), /item "item-b" is missing from predictions-kev-0.8b-ft\.jsonl/);
});

test('throws when the challenger file has an extra item the champion lacks', () => {
  const rows = validRows();
  rows['kev-0.8b-ft'] = [pred(IDS[0], true, 0.9), pred(IDS[1], false, 0.1), pred('item-extra', false, 0.2)];
  assert.match(runGenerator(writeFixture(rows)), /item "item-extra" is missing from predictions-kev-0.8b\.jsonl/);
});

test('throws when the paired files disagree on a label', () => {
  const rows = validRows();
  rows['kev-0.8b-ft'] = [pred(IDS[0], false, 0.1), pred(IDS[1], false, 0.1)];
  assert.match(runGenerator(writeFixture(rows)), /item "item-a" label differs/);
});

test('throws on a non-boolean label', () => {
  const rows = validRows();
  rows['kev-0.8b'] = [pred(IDS[0], true, 0.8), { ...pred(IDS[1], false, 0.1), label: 'false' }];
  assert.match(runGenerator(writeFixture(rows)), /non-boolean label/);
});
