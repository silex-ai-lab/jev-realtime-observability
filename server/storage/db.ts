// Storage bootstrap (plan D4): PGlite (embedded PostgreSQL) by default, or a real
// PostgreSQL when DATABASE_URL is set. Same SQL, same migrations, one interface.
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Db extends Queryable {
  readonly kind: 'pglite' | 'postgres';
  /** Runs fn in one transaction; rolls back if it throws. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface OpenDbOptions {
  /** postgres://… — uses node-postgres. */
  url?: string;
  /** PGlite data directory; omitted = in-memory (tests). */
  dataDir?: string;
}

export async function openDb(opts: OpenDbOptions = {}): Promise<Db> {
  if (opts.url) {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: opts.url, max: 10 });
    return {
      kind: 'postgres',
      query: async (sql, params) => ({ rows: (await pool.query(sql, params as unknown[])).rows }),
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const out = await fn({ query: async (sql, params) => ({ rows: (await client.query(sql, params as unknown[])).rows }) });
          await client.query('COMMIT');
          return out;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = opts.dataDir ? new PGlite(opts.dataDir) : new PGlite();
  await lite.waitReady;
  // PGlite is a single connection: transactions are serialised by its own queue.
  return {
    kind: 'pglite',
    query: async (sql, params) => ({ rows: (await lite.query(sql, params as unknown[])).rows as never[] }),
    tx: fn => lite.transaction(t => fn({ query: async (sql, params) => ({ rows: (await t.query(sql, params as unknown[])).rows as never[] }) })),
    close: () => lite.close(),
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const CORE_MIGRATIONS = join(HERE, 'migrations');

/**
 * Applies *.sql files from each directory in name order, once each, recorded in schema_migrations.
 * `set` namespaces the version so sandbox and core migrations never collide.
 */
export async function migrate(db: Db, sets: Array<{ set: string; dir: string }> = [{ set: 'core', dir: CORE_MIGRATIONS }]): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied: string[] = [];
  for (const { set, dir } of sets) {
    const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();
    for (const f of files) {
      const version = `${set}/${f}`;
      const done = await db.query(`SELECT 1 FROM schema_migrations WHERE version = $1`, [version]);
      if (done.rows.length) continue;
      const sql = await readFile(join(dir, f), 'utf8');
      await db.tx(async q => {
        for (const stmt of splitSql(sql)) await q.query(stmt);
        await q.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [version]);
      });
      applied.push(version);
    }
  }
  return applied;
}

/** Splits on semicolons at line ends; migrations must not use $$-quoted bodies. */
export function splitSql(sql: string): string[] {
  return sql
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean);
}
