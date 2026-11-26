import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDb } from '../src/db/index.js';

const url = process.env.TEST_DATABASE_URL;

// Runs only against a real Postgres (see README): the production driver's failure modes.
describe.skipIf(!url)('real Postgres', () => {
  it('survives a database connection killed under an idle pool client', async () => {
    const pg = (await import('pg')).default;
    const name = `trustphoto-kill-${randomUUID().slice(0, 8)}`;
    const errors: Error[] = [];
    const db = await openDb({ databaseUrl: url, dataDir: null, applicationName: name, onError: (err) => errors.push(err) });
    try {
      expect((await db.query<{ one: number }>('SELECT 1 AS one')).rows[0].one).toBe(1);
      const admin = new pg.Client({ connectionString: url });
      await admin.connect();
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1', [name]);
      await admin.end();
      // The pool reports the dead idle client instead of crashing the process...
      for (let i = 0; i < 50 && errors.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(errors.length).toBeGreaterThan(0);
      // ...and the next query gets a new connection.
      expect((await db.query<{ one: number }>('SELECT 1 AS one')).rows[0].one).toBe(1);
    } finally {
      await db.close();
    }
  });
});
