// The run timeline must tell a replay decision from the original (What-if and Re-check read the original):
// listDecisionsForEvent returns replay_of on replay decisions and leaves originals without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../../../server/storage/db.ts';
import * as repos from '../../../server/storage/repos.ts';

test('listDecisionsForEvent marks replay decisions with replay_of; the original comes first and has none', async () => {
  const db = await openDb();
  try {
    await migrate(db);
    const base = { tenant_id: 't-r', event_id: 'ev-1', evaluation_id: null, snapshot_id: 'snap-1', policy_version: 'p', recommended: 'NO_CONFIGURED_RISK',
      decided_by: 'default', provenance: {}, reasons: [], rule_results: [], semantic: { calibrated: false, hits: [] }, coverage_gaps: [], timings: {} };
    await repos.insertDecision(db, { ...base, decision_id: 'd-orig' } as never, null);
    await repos.insertDecision(db, { ...base, decision_id: 'd-replay', policy_version: 'p+replay-x' } as never, 'd-orig');
    const list = await repos.listDecisionsForEvent(db, 't-r', 'ev-1') as Array<{ decision_id: string; replay_of?: string }>;
    assert.deepEqual(list.map(d => [d.decision_id, d.replay_of ?? null]), [['d-orig', null], ['d-replay', 'd-orig']]);
  } finally { await db.close(); }
});
