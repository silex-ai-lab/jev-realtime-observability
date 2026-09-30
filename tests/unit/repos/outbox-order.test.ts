// readOutbox pages in numeric cursor order. It once ordered by the text alias of the cursor ('10' before '9'),
// which skipped and repeated records across pages once cursors changed digit count (found by the Sumo demo's
// export backlog test, logs/2026-09-29_SUMO_DEMO_PLAN.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../../../server/storage/db.ts';
import * as repos from '../../../server/storage/repos.ts';

test('paging through 25 outbox records 4 at a time returns each once, in numeric order', async () => {
  const db = await openDb();
  try {
    await migrate(db);
    for (let i = 0; i < 25; i++) await repos.appendOutbox(db, { tenant_id: 't-o', kind: 'decision', ref_id: `r-${i}`, run_id: null, payload: { i } });
    const seen: number[] = [];
    let after = '0';
    for (;;) {
      const page = await repos.readOutbox(db, 't-o', after, 4);
      if (!page.length) break;
      for (const r of page) seen.push((r.payload as { i: number }).i);
      after = page.at(-1)!.cursor;
    }
    assert.deepEqual(seen, Array.from({ length: 25 }, (_, i) => i));
  } finally { await db.close(); }
});
