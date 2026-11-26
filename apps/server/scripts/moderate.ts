/**
 * Operator tool for reports and removal requests. Runs against the same
 * database and storage as the server (same environment variables).
 *
 *   npm run moderate -w apps/server -- reports            open reports, most reported first
 *   npm run moderate -w apps/server -- remove <photoId>   take a proof down and delete its files
 *   npm run moderate -w apps/server -- dismiss <photoId>  close the reports of a photo that stays
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { migrate, openDb, type Db } from '../src/db/index.js';
import { localStorage, photoKeys, s3Storage, type Storage } from '../src/storage.js';
import { isPhotoId } from '../src/ids.js';

export async function openReports(db: Db) {
  const { rows } = await db.query<{ photo_id: string; reports: number; reasons: string[]; details: string[] | null; first: Date }>(
    `SELECT r.photo_id, count(*)::int AS reports, array_agg(DISTINCT r.reason) AS reasons,
            array_agg(r.details) FILTER (WHERE r.details IS NOT NULL) AS details, min(r.created_at) AS first
       FROM reports r JOIN photos p ON p.id = r.photo_id
      WHERE p.deleted_at IS NULL AND r.closed_at IS NULL
      GROUP BY r.photo_id ORDER BY reports DESC, first ASC`,
  );
  return rows;
}

/** Same effect as an owner delete, plus the reports are closed. Returns the file keys that could not be deleted. */
export async function removePhoto(db: Db, storage: Storage, id: string): Promise<{ wasLive: boolean; filesLeft: string[] }> {
  const { rows } = await db.query('UPDATE photos SET deleted_at = now(), feature_keys = NULL, feature_x = NULL, feature_y = NULL WHERE id = $1 AND deleted_at IS NULL RETURNING id', [id]);
  await db.query('UPDATE reports SET closed_at = now() WHERE photo_id = $1 AND closed_at IS NULL', [id]);
  const keys = [photoKeys.display(id), photoKeys.preview(id)];
  const results = await Promise.allSettled(keys.map((key) => storage.delete(key)));
  return { wasLive: rows.length === 1, filesLeft: keys.filter((_, i) => results[i].status === 'rejected') };
}

export async function dismissReports(db: Db, id: string): Promise<number> {
  const { rows } = await db.query('UPDATE reports SET closed_at = now() WHERE photo_id = $1 AND closed_at IS NULL RETURNING id', [id]);
  return rows.length;
}

async function main(): Promise<void> {
  const [command, id] = process.argv.slice(2);
  const cfg = loadConfig();
  const db = await openDb({ databaseUrl: cfg.databaseUrl, dataDir: cfg.dataDir ? join(cfg.dataDir, 'db') : null });
  await migrate(db);
  const storage = cfg.s3 ? await s3Storage(cfg.s3) : localStorage(join(cfg.dataDir ?? '.data', 'media'));
  try {
    if (command === 'reports') {
      const rows = await openReports(db);
      if (rows.length === 0) console.log('No open reports.');
      for (const r of rows) {
        console.log(`${r.photo_id}  ${r.reports} report(s)  ${r.reasons.join(', ')}  since ${new Date(r.first).toISOString()}  ${cfg.publicBaseUrl}/p/${r.photo_id}`);
        // JSON-quoted: report text comes from anyone and must not drive the terminal.
        for (const d of r.details ?? []) console.log(`    ${JSON.stringify(d)}`);
      }
    } else if ((command === 'remove' || command === 'dismiss') && id && isPhotoId(id)) {
      if (command === 'remove') {
        const { wasLive, filesLeft } = await removePhoto(db, storage, id);
        console.log(wasLive ? `Removed ${id} from the site.` : `${id} was not live; its reports are closed.`);
        if (filesLeft.length > 0) {
          console.error(`Could not delete these files; delete them by hand: ${filesLeft.join(', ')}`);
          process.exitCode = 1;
        }
      } else console.log(`Closed ${await dismissReports(db, id)} report(s) for ${id}.`);
    } else {
      console.log('Usage: moderate reports | remove <photoId> | dismiss <photoId>');
      process.exitCode = 1;
    }
  } finally {
    await db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
