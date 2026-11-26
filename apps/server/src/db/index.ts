import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The part of a Postgres client the server uses. Both pg and PGlite fit it. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** Inside a transaction: also several statements at once (no parameters). */
export interface Transaction extends Queryable {
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /** Runs `fn` in one transaction; it rolls back when `fn` throws. */
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  /** Runs several statements; no parameters. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Production: DATABASE_URL (any Postgres 14+). Development and tests: an
 * embedded Postgres (PGlite) in `dataDir`, or in memory when it is null.
 */
export async function openDb(opts: { databaseUrl?: string; dataDir: string | null; onError?: (err: Error) => void; applicationName?: string }): Promise<Db> {
  if (opts.databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      connectionString: opts.databaseUrl,
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
      application_name: opts.applicationName ?? 'trustphoto',
    });
    // An idle client that loses its connection (restart, failover, network)
    // emits 'error' on the pool. Without a listener that kills the process.
    pool.on('error', (err) => opts.onError?.(err));
    return {
      query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await pool.query(sql, params)).rows as T[] }),
      transaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn({
            query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params)).rows as T[] }),
            exec: async (sql) => {
              await client.query(sql);
            },
          });
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }
      },
      exec: async (sql) => {
        await pool.query(sql);
      },
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  if (opts.dataDir) await mkdir(opts.dataDir, { recursive: true });
  const lite = opts.dataDir ? new PGlite(opts.dataDir) : new PGlite();
  return {
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await lite.query<T>(sql, params)).rows }),
    transaction: (fn) =>
      lite.transaction((tx) =>
        fn({
          query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await tx.query<T>(sql, params)).rows }),
          exec: async (sql) => {
            await tx.exec(sql);
          },
        }),
      ),
    exec: async (sql) => {
      await lite.exec(sql);
    },
    close: () => lite.close(),
  };
}

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

/** Any 64-bit number unique to this app: the advisory lock key for migrations. */
const MIGRATION_LOCK = 7_316_224_901;

/**
 * Applies every migrations/*.sql not yet recorded, in file-name order. Each
 * migration runs in its own transaction under an advisory lock, so two
 * instances that start together apply it once.
 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const file of files) {
    const id = file.replace(/\.sql$/, '');
    const sql = await readFile(join(dir, file), 'utf8');
    try {
      await db.transaction(async (tx) => {
        // A migration, or the wait for another instance's, may run longer than the pool's statement timeout.
        await tx.exec('SET LOCAL statement_timeout = 0');
        await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
        await tx.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
        const { rows } = await tx.query('SELECT 1 FROM schema_migrations WHERE id = $1', [id]);
        if (rows.length > 0) return;
        await tx.exec(sql);
        await tx.query('INSERT INTO schema_migrations (id) VALUES ($1)', [id]);
        ran.push(id);
      });
    } catch (err) {
      throw new Error(`migration ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return ran;
}
