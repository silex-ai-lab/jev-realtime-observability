import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { EvalItem } from '../../contracts/eval.ts';
import rubric from '../../rubrics/jev-questions.v1.json' with { type: 'json' };

const ITEMS_PATH = new URL('../../eval/splits/items.jsonl', import.meta.url);
const KEV_TRAIN_PATH = new URL('../../eval/splits/kev-train.jsonl', import.meta.url);

test('Gate B eval split hygiene and Kev train export', async t => {
  try {
    await access(ITEMS_PATH);
  } catch {
    t.skip('eval/splits/items.jsonl does not exist yet; eval pipeline has not generated splits');
    return;
  }

  const items = parseJsonl(await readFile(ITEMS_PATH, 'utf8'));
  assert.ok(items.length > 0, 'items.jsonl should contain eval items');
  const parsed = items.map((item, index) => {
    const result = EvalItem.safeParse(item);
    assert.equal(result.success, true, `items.jsonl line ${index + 1} must validate against EvalItem: ${result.success ? '' : result.error.message}`);
    return result.data;
  });

  const templateSplits = new Map<string, string>();
  for (const item of parsed) {
    const prior = templateSplits.get(item.template_id);
    assert.ok(!prior || prior === item.split, `template_id ${item.template_id} appears in both ${prior} and ${item.split}`);
    templateSplits.set(item.template_id, item.split);
    if (item.source === 'agentdojo') assert.equal(item.split, 'test', `AgentDojo item ${item.item_id} must be test-only`);
    for (const question of item.questions) {
      assert.deepEqual(question.question, rubricQuestion(question.question_id), `${item.item_id}:${question.question_id} must use the exact rubric wire object`);
      assert.equal(JSON.stringify(question.question), JSON.stringify(rubricQuestion(question.question_id)), `${item.item_id}:${question.question_id} must be byte-equal to the rubric wire object`);
    }
  }

  await access(KEV_TRAIN_PATH);
  const kevTrain = parseJsonl(await readFile(KEV_TRAIN_PATH, 'utf8'));
  const trainItems = parsed.filter(item => item.split === 'train');
  const trainStates = new Set(trainItems.map(item => item.state));
  const nonTrainStates = new Set(parsed.filter(item => item.split !== 'train').map(item => item.state));
  assert.ok(kevTrain.length > 0, 'kev-train.jsonl should contain train examples when items exist');
  for (const [index, row] of kevTrain.entries()) {
    assert.ok(isObject(row), `kev-train line ${index + 1} must be an object`);
    assert.equal(typeof row.state, 'string', `kev-train line ${index + 1} must include state`);
    const state = row.state as string;
    assert.ok(trainStates.has(state), `kev-train line ${index + 1} state is not from a train item`);
    assert.ok(!nonTrainStates.has(state), `kev-train line ${index + 1} state also appears outside train split`);
    assert.ok(isObject(row.questions), `kev-train line ${index + 1} must include questions object`);
    for (const [qid, value] of Object.entries(row.questions)) {
      assert.ok(isObject(value), `kev-train line ${index + 1} question ${qid} must be an object`);
      const { label, ...wire } = value;
      assert.notEqual(label, undefined, `kev-train line ${index + 1} question ${qid} must include label`);
      assert.deepEqual(wire, rubricQuestion(qid), `kev-train line ${index + 1} question ${qid} must use the rubric wire object`);
      assert.ok(
        trainItems.some(item => item.state === state && item.questions.some(q => q.question_id === qid && q.label === label)),
        `kev-train line ${index + 1} question ${qid} label must come from a train item`,
      );
    }
  }
});

function parseJsonl(text: string): unknown[] {
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`invalid JSONL at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

function rubricQuestion(questionId: string): unknown {
  const questions = rubric.questions as Record<string, unknown>;
  assert.ok(Object.hasOwn(questions, questionId), `unknown rubric question ${questionId}`);
  return questions[questionId];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
