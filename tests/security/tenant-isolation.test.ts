import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectStream,
  makeBoundaryEvent,
  postEventOk,
  runWorker,
  startGateAHarness,
  waitForEvaluations,
  waitForRun,
} from '../helpers/harness.ts';

test('tenant reader keys cannot read another tenant run or evaluation', async () => {
  const h = await startGateAHarness({ judge: null });
  try {
    const event = makeBoundaryEvent({ run_id: 'run-tenant-a' });
    await postEventOk(h, event, 'alpha');
    await runWorker(h);
    await waitForRun(h, event.run_id, 'alpha');
    const evaluations = await waitForEvaluations(h, event.run_id, 'alpha');
    assert.ok(evaluations.length, 'alpha run should have an evaluation');

    const runResponse = await h.request('GET', `/v1/runs/${encodeURIComponent(event.run_id)}`, { tenant: 'beta', role: 'reader' });
    assert.equal(runResponse.status, 404, await runResponse.text());

    const evalResponse = await h.request('GET', `/v1/evaluations/${encodeURIComponent(evaluations[0].evaluation_id)}`, { tenant: 'beta', role: 'reader' });
    assert.equal(evalResponse.status, 404, await evalResponse.text());
  } finally {
    await h.close();
  }
});

test('tenant stream never carries records from another tenant', async () => {
  const h = await startGateAHarness({ judge: null });
  try {
    const alphaEvent = makeBoundaryEvent({ event_id: 'evt-alpha-stream', run_id: 'run-alpha-stream' });
    const betaEvent = makeBoundaryEvent({ event_id: 'evt-beta-stream', run_id: 'run-beta-stream' });
    await postEventOk(h, alphaEvent, 'alpha');
    await postEventOk(h, betaEvent, 'beta');
    await runWorker(h);

    const betaRecords = await collectStream(h, 'beta');
    const serialized = JSON.stringify(betaRecords);
    assert.ok(serialized.includes('run-beta-stream') || betaRecords.length === 0, 'beta stream should contain beta records when records are emitted');
    assert.ok(!serialized.includes('run-alpha-stream'), 'beta stream leaked alpha run');
    assert.ok(!serialized.includes('evt-alpha-stream'), 'beta stream leaked alpha event');
  } finally {
    await h.close();
  }
});

test('tenant_id in an event body is rejected', async () => {
  const h = await startGateAHarness({ judge: null });
  try {
    const event = { ...makeBoundaryEvent(), tenant_id: 't-beta' };
    const response = await h.request('POST', '/v1/events', { tenant: 'alpha', role: 'ingest', body: event });
    assert.equal(response.status, 400, await response.text());
  } finally {
    await h.close();
  }
});
