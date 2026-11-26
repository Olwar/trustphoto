/**
 * Makes the search keys of "Check a photo" for stored photos. Safe to run
 * again.
 *
 *   node apps/server/dist/backfill-features.js         photos that have no keys yet (after migration 005)
 *   node apps/server/dist/backfill-features.js --all   every live photo (after a change of the keys:
 *                                                      packages/shared/src/features.ts)
 */

import { join } from 'node:path';
import { storedCode } from '@trustphoto/shared/copycheck';
import { loadConfig } from '../src/config.js';
import { migrate, openDb } from '../src/db/index.js';
import { frameGray } from '../src/images.js';
import { featureColumns } from '../src/services/photos.js';
import { localStorage, photoKeys, s3Storage } from '../src/storage.js';

const cfg = loadConfig();
const db = await openDb({ databaseUrl: cfg.databaseUrl, dataDir: cfg.dataDir ? join(cfg.dataDir, 'db') : null, applicationName: 'trustphoto-backfill' });
await migrate(db);
const storage = cfg.s3 ? await s3Storage(cfg.s3) : localStorage(join(cfg.dataDir ?? '.data', 'media'));
const all = process.argv.includes('--all');
const { rows } = await db.query<{ id: string; width: number; height: number }>(
  `SELECT id, width, height FROM photos WHERE deleted_at IS NULL ${all ? '' : 'AND feature_keys IS NULL'} ORDER BY received_at`,
);
let done = 0;
for (const row of rows) {
  // One photo that cannot be read must not stop the others, in this run or the next one.
  try {
    const preview = await storage.get(photoKeys.preview(row.id));
    if (!preview) {
      console.log(`${row.id}: no preview file, skipped`);
      process.exitCode = 1;
      continue;
    }
    const code = storedCode(await frameGray(preview, row.width, row.height));
    await db.query('UPDATE photos SET feature_keys = $2::int4[], feature_x = $3::int2[], feature_y = $4::int2[] WHERE id = $1 AND deleted_at IS NULL', [row.id, ...featureColumns(code)]);
    done++;
  } catch (err) {
    console.log(`${row.id}: failed, skipped: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
console.log(`search keys made for ${done} of ${rows.length} photos`);
await db.close();
