// Eval pipeline invariants (T4): deterministic splits, rubric-exact questions, EvalItem validity,
// split hygiene (no template in two splits), AgentDojo test-only, and size caps.
// The fixture-based converters (AgentDojo, tau-bench) run here without the fetched raw data; the
// full generated eval/splits/items.jsonl is additionally validated when present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvalItem } from '../../../contracts/eval.ts';
import { finalizeSplits, splitFor, wireQuestion } from '../../../eval/convert/common.ts';
import { convertAgentdojo } from '../../../eval/convert/agentdojo.ts';
import { convertTaubench } from '../../../eval/convert/taubench.ts';
import type { EvalItem as EvalItemT } from '../../../contracts/eval.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPLITS_DIR = join(HERE, '..', '..', '..', 'eval', 'splits');

function assertValidItem(item: unknown): EvalItemT {
  const parsed = EvalItem.parse(item);
  for (const q of parsed.questions) {
    assert.deepEqual(q.question, wireQuestion(q.question_id), `${parsed.item_id}: question ${q.question_id} must be the exact rubric wire object`);
  }
  return parsed;
}

function assertSplitHygiene(items: EvalItemT[]): void {
  const seen = new Map<string, string>();
  for (const item of items) {
    const key = `${item.source}:${item.template_id}`;
    const prior = seen.get(key);
    assert.ok(!prior || prior === item.split, `template ${key} appears in both ${prior} and ${item.split}`);
    seen.set(key, item.split);
  }
}

function assertAgentdojoTestOnly(items: EvalItemT[]): void {
  for (const item of items) {
    if (item.source === 'agentdojo') assert.equal(item.split, 'test', `${item.item_id}: AgentDojo must be test-only`);
  }
}

/** The leakage invariant: no normalised judge-view state may appear in more than one split. */
function assertStateHygiene(items: EvalItemT[]): void {
  const seen = new Map<string, string>();
  for (const item of items) {
    const prior = seen.get(item.state);
    assert.ok(!prior || prior === item.split, `state appears in both ${prior} and ${item.split} (leakage)`);
    seen.set(item.state, item.split);
  }
}

/** kev-train states must be disjoint from calibration/dev/test states. */
function assertTrainDisjoint(items: EvalItemT[]): void {
  const nonTrain = new Set(items.filter(i => i.split !== 'train').map(i => i.state));
  for (const item of items) {
    if (item.split !== 'train') continue;
    assert.ok(!nonTrain.has(item.state), `kev-train state also appears outside train split`);
  }
}

test('splitFor is a deterministic hash of (source, template_id) in the 60/20/20 bands', () => {
  const ids = Array.from({ length: 200 }, (_, i) => `tpl-${i}`);
  const bySplit = new Map<string, number>();
  for (const id of ids) {
    const s = splitFor('injecagent', id);
    assert.ok(['train', 'calibration', 'dev'].includes(s));
    assert.equal(splitFor('injecagent', id), s, 'same template must always land in the same split');
    bySplit.set(s, (bySplit.get(s) ?? 0) + 1);
  }
  assert.ok((bySplit.get('train') ?? 0) > (bySplit.get('calibration') ?? 0), 'train should dominate');
  assert.ok((bySplit.get('dev') ?? 0) > 0, 'dev should be non-empty');
});

test('wireQuestion returns the exact rubric object for every id', () => {
  assert.equal(wireQuestion('instruction_override').type, 'noul');
  assert.equal(wireQuestion('payee_relation').type, 'choice');
  const si = wireQuestion('semantic_impact');
  assert.equal(si.type, 'score');
  if (si.type === 'score') assert.deepEqual(si.criteria, ['none', 'minor', 'material', 'severe']);
});

test('AgentDojo converter emits valid test-only items with rubric-exact questions', () => {
  const items = convertAgentdojo();
  assert.ok(items.length > 0);
  for (const item of items) assertValidItem(item);
  assertAgentdojoTestOnly(items);
  assert.ok(items.every(i => i.provenance.licence === 'MIT'));
});

test('tau-bench converter emits valid items within the per-source cap and rubric-exact questions', () => {
  const items = convertTaubench();
  assert.ok(items.length > 0);
  assert.ok(items.length <= 600, 'tau-bench must stay within the 600-per-source cap');
  for (const item of items) assertValidItem(item);
  assertSplitHygiene(items);
  assert.ok(items.every(i => i.questions.length === 1 && i.questions[0].question_id === 'goal_deviation' && i.questions[0].label === false));
});

test('finalizeSplits merges identical states onto one template_id so they share a split', () => {
  const base = convertAgentdojo()[0];
  const state = base.state;
  const a: EvalItemT = { ...base, template_id: 'tpl-A', split: 'train', item_id: 'agentdojo:test:tpl-A:0' };
  const b: EvalItemT = { ...base, template_id: 'tpl-B', split: 'dev', item_id: 'agentdojo:test:tpl-B:0', state };
  const out = finalizeSplits([a, b]);
  const splits = new Set(out.map(i => i.split));
  assert.equal(splits.size, 1, 'identical states must be merged into a single split');
  assert.equal(out[0].template_id, out[1].template_id, 'identical states must share a template_id');
});

test('fixture-based converters finalize without any state in two splits', () => {
  const items = finalizeSplits([...convertAgentdojo(), ...convertTaubench()]);
  assert.ok(items.length > 0);
  assertStateHygiene(items);
  assertTrainDisjoint(items);
  assertSplitHygiene(items);
  assertAgentdojoTestOnly(items);
});

test('generated items.jsonl (when present) is valid, capped and split-hygienic', async (t) => {
  const path = join(SPLITS_DIR, 'items.jsonl');
  if (!existsSync(path)) { t.skip('eval/splits/items.jsonl not generated (run node eval/convert/run.ts)'); return; }
  const items = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as unknown);
  assert.ok(items.length > 0);
  assert.ok(items.length <= 3000, `total items ${items.length} exceeds 3000`);
  const perSource = new Map<string, number>();
  const parsed: EvalItemT[] = [];
  for (const raw of items) {
    const item = assertValidItem(raw);
    parsed.push(item);
    perSource.set(item.source, (perSource.get(item.source) ?? 0) + 1);
  }
  for (const [source, n] of perSource) assert.ok(n <= 600, `${source} has ${n} items, over the 600 cap`);
  assertSplitHygiene(parsed);
  assertStateHygiene(parsed);
  assertTrainDisjoint(parsed);
  assertAgentdojoTestOnly(parsed);

  const kevPath = join(SPLITS_DIR, 'kev-train.jsonl');
  if (existsSync(kevPath)) {
    const kev = readFileSync(kevPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { state: string });
    const nonTrain = new Set(parsed.filter(i => i.split !== 'train').map(i => i.state));
    for (const row of kev) {
      assert.ok(!nonTrain.has(row.state), `kev-train state also appears outside train split`);
    }
  }

  const statsPath = join(SPLITS_DIR, 'stats.json');
  if (existsSync(statsPath)) {
    const stats = JSON.parse(readFileSync(statsPath, 'utf8')) as { total_items: number };
    assert.equal(stats.total_items, parsed.length, 'stats.json total_items must match items.jsonl');
  }
});
