// T6: label export (plan batch 2 D1/D2). Determinism, label encoding, state-group splitting, the
// human-reviewed-only test split, conflict/drop accounting, tenant isolation, and output shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, type Db } from '../../../server/storage/db.ts';
import { exportLabelsToKev } from '../../../eval/export/labels-to-kev.ts';

const AS_OF = '2999-01-01T00:00:00.000Z';
const T = (m: number, s = 0) => `2026-01-01T00:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`;

async function freshDb(): Promise<Db> {
  const db = await openDb();
  await migrate(db);
  return db;
}

async function seedSnapshot(db: Db, tenant: string, id: string, state: string, at: string) {
  await db.query(
    `INSERT INTO snapshots (tenant_id, snapshot_id, event_id, revision, body, created_at) VALUES ($1,$2,$3,1,$4,$5::timestamptz)`,
    [tenant, id, `evt-${id}`, JSON.stringify({ judge_view: { state, token_estimate: state.length, truncated: false } }), at]);
}

async function seedEvaluation(db: Db, tenant: string, id: string, snapshotId: string, at: string) {
  await db.query(
    `INSERT INTO evaluations (tenant_id, evaluation_id, event_id, snapshot_id, kind, status, judge_source, body, created_at) VALUES ($1,$2,$3,$4,'realtime','ok',NULL,$5,$6::timestamptz)`,
    [tenant, id, `evt-${id}`, snapshotId, JSON.stringify({}), at]);
}

async function seedLabel(db: Db, tenant: string, id: string, ref: string, questionId: string, value: unknown, cls: string, at: string) {
  await db.query(
    `INSERT INTO labels (label_id, tenant_id, ref, question_id, value, evidence_class, source, created_at) VALUES ($1,$2,$3,$4,$5,$6,'test',$7::timestamptz)`,
    [id, tenant, ref, questionId, JSON.stringify(value), cls, at]);
}

function lines(content: string): Array<Record<string, unknown>> {
  return content.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);
}
function combined(r: { train: string; calibration: string; test: string }): Array<Record<string, unknown>> {
  return [...lines(r.train), ...lines(r.calibration), ...lines(r.test)];
}

test('label encoding: noul boolean, choice key, score index', async () => {
  const db = await freshDb();
  try {
    await seedSnapshot(db, 't-alpha', 's1', 'STATE-1', T(1));
    await seedLabel(db, 't-alpha', 'l1', 's1', 'goal_deviation', true, 'human_reviewed', T(1));
    await seedLabel(db, 't-alpha', 'l2', 's1', 'payee_relation', 'different_entity', 'human_reviewed', T(1));
    await seedLabel(db, 't-alpha', 'l3', 's1', 'semantic_impact', 'material', 'human_reviewed', T(1));

    const r = await exportLabelsToKev(db, { tenant: 't-alpha', asOf: AS_OF });
    const rows = combined(r);
    assert.equal(rows.length, 1);
    const qs = rows[0].questions as Record<string, { label: unknown; type: string }>;
    assert.equal(qs.goal_deviation.label, true);
    assert.equal(qs.payee_relation.label, 'different_entity');
    assert.equal(qs.semantic_impact.label, 2, 'score "material" must be encoded as the index 2');
    assert.equal(qs.semantic_impact.type, 'score');
  } finally { await db.close(); }
});

test('byte-identical rerun on the same DB and --as-of', async () => {
  const db = await freshDb();
  try {
    await seedSnapshot(db, 't-alpha', 's1', 'STATE-A', T(1));
    await seedLabel(db, 't-alpha', 'l1', 's1', 'goal_deviation', true, 'human_reviewed', T(1));
    await seedSnapshot(db, 't-alpha', 's2', 'STATE-B', T(2));
    await seedLabel(db, 't-alpha', 'l2', 's2', 'goal_deviation', false, 'heuristic_derived', T(2));

    const a = await exportLabelsToKev(db, { tenant: 't-alpha', asOf: AS_OF });
    const b = await exportLabelsToKev(db, { tenant: 't-alpha', asOf: AS_OF });
    assert.equal(a.train, b.train);
    assert.equal(a.calibration, b.calibration);
    assert.equal(a.test, b.test);
    assert.deepEqual(a.manifest, b.manifest);
  } finally { await db.close(); }
});

test('state groups: identical state text dated across train/cal/test lands together in train; grouping count 2', async () => {
  const db = await freshDb();
  try {
    // 10 distinct snapshots + 3 identical-state snapshots whose singleton positions fall in train, cal and test.
    for (let i = 1; i <= 10; i++) {
      await seedSnapshot(db, 't-alpha', `d${i}`, `DISTINCT-${i}`, T(i));
      await seedLabel(db, 't-alpha', `ld${i}`, `d${i}`, 'goal_deviation', true, 'human_reviewed', T(i));
    }
    await seedSnapshot(db, 't-alpha', 's1', 'SHARED', T(3, 30));
    await seedSnapshot(db, 't-alpha', 's2', 'SHARED', T(8, 30));
    await seedSnapshot(db, 't-alpha', 's3', 'SHARED', T(9, 30));
    await seedLabel(db, 't-alpha', 'ls1', 's1', 'goal_deviation', true, 'human_reviewed', T(3, 30));
    await seedLabel(db, 't-alpha', 'ls2', 's2', 'goal_deviation', true, 'human_reviewed', T(8, 30));
    await seedLabel(db, 't-alpha', 'ls3', 's3', 'goal_deviation', true, 'human_reviewed', T(9, 30));

    const r = await exportLabelsToKev(db, { tenant: 't-alpha', asOf: AS_OF });
    assert.equal((r.manifest.moved_by_grouping as number), 2, 'two shared snapshots were folded into the earliest one');
    const train = lines(r.train), cal = lines(r.calibration), test = lines(r.test);
    assert.equal(train.filter(x => x.state === 'SHARED').length, 3, 'all three shared snapshots land in train');
    assert.equal(cal.filter(x => x.state === 'SHARED').length, 0);
    assert.equal(test.filter(x => x.state === 'SHARED').length, 0);
  } finally { await db.close(); }
});

test('test split keeps only human_reviewed questions; a test snapshot with none left is dropped and counted', async () => {
  const db = await freshDb();
  try {
    await seedSnapshot(db, 't-alpha', 's1', 'TRAIN-1', T(1));
    await seedLabel(db, 't-alpha', 'l1', 's1', 'goal_deviation', true, 'human_reviewed', T(1));
    await seedSnapshot(db, 't-alpha', 's2', 'TRAIN-2', T(2));
    await seedLabel(db, 't-alpha', 'l2', 's2', 'goal_deviation', true, 'heuristic_derived', T(2));
    // Two test snapshots: one keeps a human answer, one has only heuristic answers and is dropped.
    await seedSnapshot(db, 't-alpha', 's3', 'TEST-1', T(3));
    await seedLabel(db, 't-alpha', 'l3', 's3', 'goal_deviation', true, 'human_reviewed', T(3));
    await seedLabel(db, 't-alpha', 'l4', 's3', 'instruction_override', false, 'heuristic_derived', T(3));
    await seedSnapshot(db, 't-alpha', 's4', 'TEST-2', T(4));
    await seedLabel(db, 't-alpha', 'l5', 's4', 'goal_deviation', true, 'heuristic_derived', T(4));

    const r = await exportLabelsToKev(db, { tenant: 't-alpha', asOf: AS_OF });
    const test = lines(r.test);
    assert.equal(test.length, 1, 'only the test snapshot with a human answer survives');
    const qs = test[0].questions as Record<string, unknown>;
    assert.ok(qs.goal_deviation, 'human-reviewed question kept');
    assert.ok(!qs.instruction_override, 'heuristic question dropped from the test split');
    assert.equal((r.manifest.dropped as { test_without_human_reviewed: number }).test_without_human_reviewed, 1);
  } finally { await db.close(); }
});

test('conflicting human_reviewed answers drop the question and are counted', async () => {
  const db = await freshDb();
  try {
    await seedSnapshot(db, 't-alpha', 's1', 'CONFLICT', T(1));
    await seedLabel(db, 't-alpha', 'l1', 's1', 'goal_deviation', true, 'human_reviewed', T(1));
    await seedLabel(db, 't-alpha', 'l2', 's1', 'goal_deviation', false, 'human_reviewed', T(2));
    await seedLabel(db, 't-alpha', 'l3', 's1', 'sensitive_data_transfer', false, 'human_reviewed', T(1));

    const r = await exportLabelsToKev(db, { tenant: 't-alpha', asOf: AS_OF });
    const rows = combined(r);
    assert.equal(rows.length, 1);
    const qs = rows[0].questions as Record<string, unknown>;
    assert.ok(!qs.goal_deviation, 'conflicting question dropped');
    assert.ok(qs.sensitive_data_transfer, 'unconflicted question kept');
    assert.equal((r.manifest.dropped as { conflicting: number }).conflicting, 1);
  } finally { await db.close(); }
});

test('tenant isolation: labels of another tenant are never read', async () => {
  const db = await freshDb();
  try {
    await seedSnapshot(db, 't-alpha', 's1', 'ALPHA', T(1));
    await seedLabel(db, 't-alpha', 'l1', 's1', 'goal_deviation', true, 'human_reviewed', T(1));
    await seedSnapshot(db, 't-beta', 's2', 'BETA', T(1));
    await seedLabel(db, 't-beta', 'l2', 's2', 'goal_deviation', true, 'human_reviewed', T(1));

    const r = await exportLabelsToKev(db, { tenant: 't-alpha', asOf: AS_OF });
    const all = [...lines(r.train), ...lines(r.calibration), ...lines(r.test)];
    assert.equal(all.length, 1);
    assert.equal(all[0].state, 'ALPHA');
  } finally { await db.close(); }
});

test('an evaluation-id ref is mapped to its snapshot', async () => {
  const db = await freshDb();
  try {
    await seedSnapshot(db, 't-alpha', 's1', 'VIA-EVAL', T(1));
    await seedEvaluation(db, 't-alpha', 'e1', 's1', T(1));
    await seedLabel(db, 't-alpha', 'l1', 'e1', 'goal_deviation', true, 'human_reviewed', T(1));

    const r = await exportLabelsToKev(db, { tenant: 't-alpha', asOf: AS_OF });
    assert.equal(combined(r).length, 1);
    assert.equal(combined(r)[0].state, 'VIA-EVAL');
  } finally { await db.close(); }
});

test('output shape matches eval/splits/kev-train.jsonl', async () => {
  const db = await freshDb();
  try {
    await seedSnapshot(db, 't-alpha', 's1', 'SHAPE', T(1));
    await seedLabel(db, 't-alpha', 'l1', 's1', 'goal_deviation', true, 'human_reviewed', T(1));
    await seedLabel(db, 't-alpha', 'l2', 's1', 'payee_relation', 'same_entity', 'human_reviewed', T(1));
    await seedLabel(db, 't-alpha', 'l3', 's1', 'semantic_impact', 'severe', 'human_reviewed', T(1));

    const r = await exportLabelsToKev(db, { tenant: 't-alpha', asOf: AS_OF });
    const rows = combined(r);
    assert.equal(rows.length, 1);
    for (const row of rows) {
      assert.equal(typeof row.state, 'string');
      const qs = row.questions as Record<string, { type: string; instructions: string; label: unknown; criteria?: unknown }>;
      assert.ok(Object.keys(qs).length >= 1);
      for (const q of Object.values(qs)) {
        assert.ok(['noul', 'choice', 'score'].includes(q.type));
        assert.equal(typeof q.instructions, 'string');
        if (q.type === 'noul') assert.equal(typeof q.label, 'boolean');
        if (q.type === 'choice') { assert.equal(typeof q.label, 'string'); assert.ok(q.criteria); }
        if (q.type === 'score') { assert.equal(typeof q.label, 'number'); assert.ok(Array.isArray(q.criteria)); }
      }
    }
  } finally { await db.close(); }
});
