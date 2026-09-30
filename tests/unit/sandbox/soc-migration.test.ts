// A database that applied sandbox/schema.sql before the SOC domain existed (every deployment before
// logs/2026-09-29_SUMO_DEMO_PLAN.md) still gets the SOC tables: they live in their own migration file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../../../server/storage/db.ts';
import { seedSandbox } from '../../../sandbox/index.ts';

test('an existing sandbox (schema.sql already applied) gains the SOC tables and seed', async () => {
  const db = await openDb();
  try {
    await migrate(db);
    const old = mkdtempSync(join(tmpdir(), 'sandbox-old-'));
    copyFileSync('sandbox/schema.sql', join(old, 'schema.sql'));
    await migrate(db, [{ set: 'sandbox', dir: old }]);                    // the pre-SOC state: only schema.sql recorded
    const before = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'sandbox' AND table_name LIKE 'soc_%'`);
    assert.equal(before.rows[0].n, 0);
    await seedSandbox(db, 't-alpha');                                     // applies sandbox/schema_002_soc.sql, then seeds
    const users = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM sandbox.soc_users WHERE tenant_id = 't-alpha'`);
    assert.ok(users.rows[0].n > 0);
    await seedSandbox(db, 't-alpha');                                     // idempotent
  } finally { await db.close(); }
});
