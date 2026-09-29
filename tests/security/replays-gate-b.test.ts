import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findObjects,
  isObject,
  makeBoundaryEvent,
  postEventOk,
  runWorker,
  startGateAHarness,
  startSandboxRun,
  startStubJudge,
  waitFor,
  waitForDecision,
  waitForEvaluations,
  waitForRun,
} from '../helpers/harness.ts';
import type { EvaluationRecord } from '../../contracts/judge.ts';
import type { PolicyDecision } from '../../contracts/decision.ts';

test('Gate B model_reeval creates new evaluation and judge call without mutating the original records', async () => {
  const judge = await startStubJudge();
  const h = await startGateAHarness({
    judge: {
      backend: 'stub',
      baseUrl: judge.url,
      model: 'kev-latest',
      expectedRun: 'stub',
      maxRps: 100,
      maxInputTokensPerSec: 1_000_000,
      maxResponseBytes: 1_000_000,
    },
    worker: { autostart: false, leaseMs: 30_000, realtimeTtlMs: 60_000 },
  });
  try {
    const event = makeBoundaryEvent();
    await postEventOk(h, event);
    await runWorker(h);
    const originalDecision = await waitForDecision(h, event.run_id);
    const originalEvaluation = (await waitForEvaluations(h, event.run_id))[0];
    assert.ok(originalEvaluation);
    const originalEvaluationRow = await singleRowById(h.db, 'evaluations', 'evaluation_id', originalEvaluation.evaluation_id);
    const originalDecisionRow = await singleRowById(h.db, 'decisions', 'decision_id', originalDecision.decision_id);
    const callsBeforeReplay = await countModelReevalJudgeCalls(h.db);

    const response = await h.request('POST', '/v1/replays', {
      tenant: 'alpha',
      role: 'reader',
      body: { kind: 'model_reeval', decision_ids: [originalDecision.decision_id] },
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const replay = JSON.parse(text) as { judge_calls?: number };

    const replayEvaluation = await waitFor(async () => {
      const result = await h.db.query<{ evaluation_id: string; kind: string; body: EvaluationRecord }>(
        `SELECT evaluation_id, kind, body FROM evaluations
         WHERE tenant_id = $1 AND event_id = $2 AND kind = 'model_reeval'
         ORDER BY created_at DESC`,
        ['t-alpha', event.event_id],
      );
      return result.rows.find(row => row.evaluation_id !== originalEvaluation.evaluation_id) ?? null;
    }, 'model_reeval evaluation', 10_000);
    assert.equal(replayEvaluation.kind, 'model_reeval');
    assert.notEqual(replayEvaluation.evaluation_id, originalEvaluation.evaluation_id);
    assert.equal(replayEvaluation.body.status, 'ok', 'model_reeval must not silently pass with model_mismatch or any non-ok status');

    const calls = await h.db.query<{ caller: string; evaluation_id: string }>(
      `SELECT caller, evaluation_id FROM judge_calls WHERE tenant_id = $1 AND evaluation_id = $2`,
      ['t-alpha', replayEvaluation.evaluation_id],
    );
    assert.ok(calls.rows.some(row => row.caller === 'model_reeval'), 'model_reeval must be recorded as the judge_call caller');
    const callsAfterReplay = await countModelReevalJudgeCalls(h.db);
    assert.equal(replay.judge_calls, callsAfterReplay - callsBeforeReplay, 'response judge_calls must equal outbound judge_call ledger rows written');
    assert.equal(replay.judge_calls, calls.rows.length, 'single-decision replay should report the judge_call rows for its replay evaluation');

    const replayDecision = await waitFor(async () => {
      const result = await h.db.query<{ decision_id: string; replay_of: string | null; body: PolicyDecision }>(
        `SELECT decision_id, replay_of, body FROM decisions WHERE tenant_id = $1 AND replay_of = $2`,
        ['t-alpha', originalDecision.decision_id],
      );
      return result.rows[0] ?? null;
    }, 'model_reeval replay decision', 10_000);
    assert.equal(replayDecision.replay_of, originalDecision.decision_id);

    assert.deepEqual(await singleRowById(h.db, 'evaluations', 'evaluation_id', originalEvaluation.evaluation_id), originalEvaluationRow);
    assert.deepEqual(await singleRowById(h.db, 'decisions', 'decision_id', originalDecision.decision_id), originalDecisionRow);
  } finally {
    await h.close();
    await judge.close();
  }
});

test('Gate B model_reeval rejects more than 20 decisions per call', async () => {
  const h = await startGateAHarness({ judge: null });
  try {
    const response = await h.request('POST', '/v1/replays', {
      tenant: 'alpha',
      role: 'reader',
      body: { kind: 'model_reeval', decision_ids: Array.from({ length: 21 }, (_, i) => `decision-${i}`) },
    });
    const text = await response.text();
    assert.equal(response.status, 400, text);
  } finally {
    await h.close();
  }
});

test('Gate B sandbox_reexec creates a new run with new operation ids and leaves original ledger untouched', { timeout: 30_000 }, async () => {
  const judge = await startStubJudge();
  const h = await startGateAHarness({
    judge: {
      backend: 'stub',
      baseUrl: judge.url,
      model: 'kev-latest',
      expectedRun: 'stub',
      maxRps: 100,
      maxInputTokensPerSec: 1_000_000,
      maxResponseBytes: 1_000_000,
    },
    worker: { autostart: true, leaseMs: 30_000, realtimeTtlMs: 60_000 },
  });
  try {
    const originalRunId = await startSandboxRun(h, 'S1');
    await waitForDecision(h, originalRunId, 'alpha', 15_000);
    const originalRun = await waitForRun(h, originalRunId);
    const originalOperationIds = operationIds(originalRun);
    assert.ok(originalOperationIds.length > 0, 'original sandbox run should contain operation ids');
    const ledgerBefore = await ledgerRows(h, originalOperationIds);

    const readerResponse = await h.request('POST', '/v1/replays', {
      tenant: 'alpha',
      role: 'reader',
      body: { kind: 'sandbox_reexec', run_id: originalRunId },
    });
    const readerText = await readerResponse.text();
    assert.equal(readerResponse.status, 403, readerText);

    const response = await h.json<{ run_id?: string }>('POST', '/v1/replays', {
      tenant: 'alpha',
      role: 'admin',
      body: { kind: 'sandbox_reexec', run_id: originalRunId },
    });
    assert.ok(response.response.status === 200 || response.response.status === 202, JSON.stringify(response.body));
    assert.equal(typeof response.body.run_id, 'string', 'sandbox_reexec must return a new run_id');
    const replayRunId = response.body.run_id as string;
    assert.notEqual(replayRunId, originalRunId);

    await waitForDecision(h, replayRunId, 'alpha', 15_000);
    const replayRun = await waitForRun(h, replayRunId);
    const replayOperationIds = operationIds(replayRun);
    assert.ok(replayOperationIds.length > 0, 're-executed sandbox run should contain operation ids');
    assert.deepEqual(intersection(originalOperationIds, replayOperationIds), [], 'sandbox_reexec must use fresh operation ids');

    assert.deepEqual(await ledgerRows(h, originalOperationIds), ledgerBefore, 'sandbox_reexec must not re-execute original operations');
    const allLedger = await h.db.query<{ operation_id: string }>(
      `SELECT operation_id FROM sandbox.ledger WHERE tenant_id = $1 ORDER BY operation_id`,
      ['t-alpha'],
    );
    for (const operationId of originalOperationIds) {
      const count = allLedger.rows.filter(row => row.operation_id === operationId).length;
      const beforeCount = ledgerBefore.filter(row => row.operation_id === operationId).length;
      assert.equal(count, beforeCount, `original operation ${operationId} should not gain duplicate ledger rows`);
    }
  } finally {
    await h.close();
    await judge.close();
  }
});

async function singleRowById(db: { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }, table: string, idColumn: string, id: string): Promise<unknown> {
  const safeTable = `"${table.replaceAll('"', '""')}"`;
  const safeColumn = `"${idColumn.replaceAll('"', '""')}"`;
  const result = await db.query(`SELECT * FROM ${safeTable} WHERE ${safeColumn} = $1`, [id]);
  assert.equal(result.rows.length, 1, `expected one ${table}.${idColumn} row for ${id}`);
  return result.rows[0];
}

async function ledgerRows(h: { db: { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> } }, operationIds: string[]): Promise<Array<Record<string, unknown>>> {
  if (!operationIds.length) return [];
  const result = await h.db.query<Record<string, unknown>>(
    `SELECT * FROM sandbox.ledger WHERE tenant_id = $1 AND operation_id = ANY($2) ORDER BY operation_id, tx_id`,
    ['t-alpha', operationIds],
  );
  return result.rows;
}

async function countModelReevalJudgeCalls(db: { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }): Promise<number> {
  const result = await db.query<{ count: string | number }>(
    `SELECT count(*) AS count FROM judge_calls WHERE tenant_id = $1 AND caller = 'model_reeval'`,
    ['t-alpha'],
  );
  return Number(result.rows[0]?.count ?? 0);
}

function operationIds(root: unknown): string[] {
  return [...new Set(findObjects<Record<string, unknown>>(root, v => isObject(v) && typeof v.operation_id === 'string').map(v => String(v.operation_id)))].sort();
}

function intersection(left: string[], right: string[]): string[] {
  const r = new Set(right);
  return left.filter(value => r.has(value)).sort();
}
