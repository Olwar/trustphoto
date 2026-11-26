import type { PublicCheck, PublicPhoto } from '@trustphoto/shared';
import { MAX_CANDIDATES, MIN_SHARED_KEYS, sharedSpots, SPOT_SCALE, type SharedSpot, type StoredCode } from '@trustphoto/shared/copycheck';
import type { Context } from '../context.js';
import type { Db, Queryable } from '../db/index.js';
import { photoKeys } from '../storage.js';

export interface PhotoRow {
  id: string;
  install_id: string;
  received_at: string | Date;
  original_sha256: string;
  public_sha256: string;
  phash: string;
  width: number;
  height: number;
  device_label: string | null;
  checks: PublicCheck[];
  is_test: boolean;
  receipt: Record<string, unknown>;
  signature: string;
  deleted_at: string | Date | null;
}

export const PHOTO_COLUMNS =
  'id, install_id, received_at, original_sha256, public_sha256, phash, width, height, device_label, checks, is_test, receipt, signature, deleted_at';

export function toPublicPhoto(row: PhotoRow, baseUrl: string): PublicPhoto {
  return {
    id: row.id,
    url: `${baseUrl}/p/${row.id}`,
    imageUrl: `${baseUrl}/i/${row.id}.jpg`,
    receivedAt: new Date(row.received_at).toISOString(),
    device: row.device_label,
    width: row.width,
    height: row.height,
    isTest: row.is_test,
    checks: row.checks,
  };
}

/** A live (not deleted) photo, or null. */
export async function findPhoto(db: Queryable, id: string): Promise<PhotoRow | null> {
  const { rows } = await db.query<PhotoRow>(`SELECT ${PHOTO_COLUMNS} FROM photos WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows[0] ?? null;
}

export async function findPhotoByCapture(db: Queryable, captureId: string): Promise<PhotoRow | null> {
  const { rows } = await db.query<PhotoRow>(`SELECT ${PHOTO_COLUMNS} FROM photos WHERE capture_id = $1 AND deleted_at IS NULL`, [captureId]);
  return rows[0] ?? null;
}

export const PAGE_SIZE = 60;

/** Newest first, PAGE_SIZE at a time. `after` is the ID of the last photo of the previous page. */
export async function listInstallPhotos(db: Queryable, installId: string, after: string | null): Promise<PhotoRow[]> {
  const { rows } = await db.query<PhotoRow>(
    `SELECT ${PHOTO_COLUMNS} FROM photos
      WHERE install_id = $1 AND deleted_at IS NULL
        AND ($2::text IS NULL OR (received_at, id) < (SELECT received_at, id FROM photos WHERE id = $2 AND install_id = $1))
      ORDER BY received_at DESC, id DESC LIMIT $3`,
    [installId, after, PAGE_SIZE],
  );
  return rows;
}

/**
 * Owner delete: the proof page stops at once (the row is marked deleted and
 * every route checks that); the files are removed right after. A storage
 * error is logged, not returned: the proof is already gone for every reader.
 * The capture row stays as the replay fence.
 */
export async function deleteInstallPhoto(ctx: Context, installId: string, id: string, log: (msg: string) => void): Promise<boolean> {
  const { rows } = await ctx.db.query<{ id: string }>(
    'UPDATE photos SET deleted_at = now(), feature_keys = NULL, feature_x = NULL, feature_y = NULL WHERE id = $1 AND install_id = $2 AND deleted_at IS NULL RETURNING id',
    [id, installId],
  );
  if (rows.length === 0) return false;
  const results = await Promise.allSettled([ctx.storage.delete(photoKeys.display(id)), ctx.storage.delete(photoKeys.preview(id))]);
  if (results.some((r) => r.status === 'rejected')) log(`photo ${id}: files not removed from storage; remove them by hand`);
  return true;
}

/** The live photo that has this exact file: the verified original or the public copy. */
export async function findPhotoByFile(db: Queryable, sha256: string): Promise<PhotoRow | null> {
  const { rows } = await db.query<PhotoRow>(
    `SELECT ${PHOTO_COLUMNS} FROM photos WHERE (public_sha256 = $1 OR original_sha256 = $1) AND deleted_at IS NULL LIMIT 1`,
    [sha256],
  );
  return rows[0] ?? null;
}

/** The three feature columns of a photo row, as query parameters. */
export function featureColumns(code: StoredCode): [number[], number[], number[]] {
  const fixed = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * SPOT_SCALE)));
  return [Array.from(code.keys), Array.from(code.x, fixed), Array.from(code.y, fixed)];
}

/**
 * Live photos whose pHash is within `maxDistance` bits of one of the given
 * pHashes (the file in each orientation), nearest first. `orientation` is the
 * index of the pHash that matched. Scans every live photo: fine for thousands of
 * photos; past that it needs an index (multi-index hashing on 16-bit pHash chunks).
 */
export async function phashCandidates(db: Queryable, phashes: string[], maxDistance: number): Promise<Array<{ row: PhotoRow; orientation: number }>> {
  const { rows } = await db.query<PhotoRow & { orientation: number }>(
    `SELECT * FROM (
       SELECT DISTINCT ON (p.id) ${PHOTO_COLUMNS.split(', ').map((c) => `p.${c}`).join(', ')}, (o.ord - 1)::int AS orientation,
              bit_count(('x' || p.phash)::bit(64) # ('x' || o.hash)::bit(64))::int AS distance
         FROM photos p CROSS JOIN unnest($1::text[]) WITH ORDINALITY AS o(hash, ord)
        WHERE p.deleted_at IS NULL AND bit_count(('x' || p.phash)::bit(64) # ('x' || o.hash)::bit(64)) <= $2
        ORDER BY p.id, distance ASC, o.ord ASC
     ) nearest ORDER BY distance ASC, received_at DESC LIMIT $3`,
    [phashes, maxDistance, MAX_CANDIDATES],
  );
  return rows.map((row) => ({ row, orientation: row.orientation }));
}

/** The longest that the key search may run. Past it the lookup fails with an error, never with "no proof". */
const KEY_SEARCH_MS = 2_000;

/**
 * Live photos that share the most search keys with the file, with the spots of
 * those shared keys. Sharing keys proves nothing (plain corners look the same
 * in every picture): the confirm step decides.
 *
 * The count reads the keys of every live photo (a hash join with the file's
 * keys), so its time grows with the number of photos: about 0.4 ms for each
 * photo on a laptop. An overlap test first (`feature_keys && $1`) would be far
 * slower: Postgres compares every stored key with every key of the file. See
 * "Scale" in the README.
 */
export async function keyCandidates(db: Db, keys: Int32Array): Promise<Array<{ row: PhotoRow; spots: SharedSpot[] }>> {
  const distinct = [...new Set(keys)];
  if (distinct.length === 0) return [];
  const ids = await db.transaction(async (tx) => {
    await tx.exec(`SET LOCAL statement_timeout = ${KEY_SEARCH_MS}`);
    const { rows } = await tx.query<{ id: string }>(
      `WITH q AS (SELECT DISTINCT k FROM unnest($1::int4[]) AS t(k))
       SELECT p.id, count(*)::int AS shared
         FROM photos p CROSS JOIN LATERAL unnest(p.feature_keys) AS s(k) JOIN q ON q.k = s.k
        WHERE p.deleted_at IS NULL AND p.feature_keys IS NOT NULL
        GROUP BY p.id HAVING count(*) >= $2
        ORDER BY shared DESC, p.id LIMIT $3`,
      [distinct, MIN_SHARED_KEYS, MAX_CANDIDATES],
    );
    return rows.map((r) => r.id);
  });
  if (ids.length === 0) return [];
  const { rows } = await db.query<PhotoRow & { feature_keys: number[]; feature_x: number[]; feature_y: number[] }>(
    `SELECT ${PHOTO_COLUMNS}, feature_keys, feature_x, feature_y FROM photos WHERE id = ANY($1::text[]) AND deleted_at IS NULL AND feature_keys IS NOT NULL`,
    [ids],
  );
  const wanted = new Set(distinct);
  return ids.flatMap((id) => {
    const row = rows.find((r) => r.id === id);
    return row ? [{ row, spots: sharedSpots({ keys: row.feature_keys, x: row.feature_x, y: row.feature_y }, wanted, SPOT_SCALE) }] : [];
  });
}
