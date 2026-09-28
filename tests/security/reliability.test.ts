import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeBoundaryEvent,
  makeDataDir,
  postEvent,
  postEventOk,
  runWorker,
  startGateAHarness,
  waitForEvaluations,
} from '../helpers/harness.ts';

test('accepted events survive restart and queued jobs evaluate on the same PGlite dataDir', async () => {
  const dataDir = await makeDataDir();
  const first = await startGateAHarness({ dataDir, judge: null, worker: { autostart: false, leaseMs: 50, realtimeTtlMs: 10_000 } });
  const event = makeBoundaryEvent({ event_id: 'evt-restart-survives', run_id: 'run-restart-survives' });
  try {
    const response = await postEvent(first, event);
    assert.equal(response.status, 202, await response.text());
  } finally {
    await first.close();
  }

  const second = await startGateAHarness({ dataDir, judge: null, worker: { autostart: false, leaseMs: 50, realtimeTtlMs: 10_000 } });
  try {
    await runWorker(second);
    const evaluations = await waitForEvaluations(second, event.run_id);
    assert.ok(evaluations.length, 'queued job did not evaluate after restart');
    assert.equal(evaluations[0].event_id, event.event_id);
  } finally {
    await second.close();
  }
});

test('duplicate event id with same content is duplicate and creates no second job; different content conflicts', async () => {
  const h = await startGateAHarness({ judge: null, worker: { autostart: false, leaseMs: 50, realtimeTtlMs: 10_000 } });
  try {
    const event = makeBoundaryEvent({ event_id: 'evt-duplicate', run_id: 'run-duplicate' });
    await postEventOk(h, event);

    const same = await h.request('POST', '/v1/events', { tenant: 'alpha', role: 'ingest', body: event });
    const sameText = await same.text();
    assert.equal(same.status, 202, sameText);
    const sameBody = JSON.parse(sameText) as { accepted?: Array<{ event_id: string; status: string }> };
    assert.equal(sameBody.accepted?.[0]?.status, 'duplicate');

    const jobCount = await h.db.query<{ count: string | number }>(
      'SELECT count(*) AS count FROM evaluation_jobs WHERE tenant_id = $1 AND event_id = $2',
      ['t-alpha', event.event_id],
    );
    assert.equal(Number(jobCount.rows[0]?.count ?? 0), 1, 'duplicate event created a second job');

    const different = { ...event, producer_seq: event.producer_seq + 1 };
    const conflict = await h.request('POST', '/v1/events', { tenant: 'alpha', role: 'ingest', body: different });
    assert.equal(conflict.status, 409, await conflict.text());
  } finally {
    await h.close();
  }
});
