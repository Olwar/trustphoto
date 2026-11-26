/**
 * One upload, start to end: the upload checks, the device commitment, the
 * photo checks, the verdict and, for a verified photo, the public proof.
 * Runs inside the request so the phone gets its answer at once.
 *
 * Order matters: cheap checks first, then the single-use nonce, then the
 * device check, and only then the expensive decode and photo checks
 * (limited per instance by ctx.limitVerification).
 *
 * The photo checks themselves are behind ctx.checks (src/checks/types.ts).
 * This file decides nothing about what a camera photo looks like.
 */

import { randomUUID } from 'node:crypto';
import {
  computeBindingHash,
  computeDeviceDigest,
  computeSensorDigest,
  MAX_CLOCK_AHEAD_MS,
  MAX_SENSOR_SAMPLES,
  MAX_SHOT_AGE_MS,
  NONCE_TTL_MS,
  NOT_VERIFIED_MESSAGES,
  type CaptureBundle,
  type CaptureResult,
  type DeviceInfo,
  type NotVerifiedReason,
  type SensorSample,
} from '@trustphoto/shared';
import type { Context } from '../context.js';
import { verifyCommitment, type AppAttestKeyStore, type AttestationOutcome } from '../attest/commitment.js';
import type { Decision, PhotoAnalysis, ScreenDecision } from '../checks/types.js';
import { BusyError } from '../limits.js';
import type { DecodeLane } from '../attest/play-integrity.js';
import { inspectImage, makePublicImages, MAX_PIXELS, type PublicImages } from '../images.js';
import { hmacHex, newPhotoId, sha256Hex } from '../ids.js';
import { photoKeys } from '../storage.js';
import { featureColumns, findPhotoByCapture, toPublicPhoto, type PhotoRow } from './photos.js';

/** A request the server refuses before any verdict; the route maps it to an HTTP status. */
export class CaptureError extends Error {
  constructor(
    readonly status: 400 | 409 | 413 | 429 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Replays of the photo checks' motion fingerprint are fenced within one install for this long. */
const FINGERPRINT_FENCE_DAYS = 30;
/**
 * Google (Play Integrity) calls. Free install tokens must not be able to
 * spend the daily quota real phones need, so every call is booked:
 * - an install that never passed: 5 a day, its address 30 an hour, and all
 *   such installs together `cfg.unprovenDailyGoogleCalls` a day;
 * - an install that passed before: 200 a day.
 * A booking is returned when Google gave no answer, so an outage never
 * counts against a phone.
 */
const UNPROVEN_CALLS_PER_INSTALL_PER_DAY = 5;
const UNPROVEN_CALLS_PER_ADDRESS_PER_HOUR = 30;
const PROVEN_CALLS_PER_INSTALL_PER_DAY = 200;
const PROVEN_CALLS_PER_ADDRESS_PER_DAY = 1000;
const DAY_MS = 86_400_000;

const tryAgain = (code: string, message: string) => new CaptureError(503, code, message);

/** The photo files could not be written: an outage, not the client's doing. */
class StorageError extends Error {}

const INSERT_CAPTURE = `INSERT INTO captures (id, install_id, received_at, image_sha256, sensor_digest, sensor_fingerprint, status, reason, score,
    attestation_verdict, platform, device_model, app_version, client_captured_at, result)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`;

export async function processCapture(
  ctx: Context,
  args: {
    installId: string;
    bundle: CaptureBundle;
    photo: Buffer;
    requestStartedAt: number;
    /** The client address key (see client-ip.ts), for per-address budgets. */
    clientKey: string;
  },
): Promise<CaptureResult> {
  const { installId, bundle, photo } = args;
  const receivedAt = ctx.now();
  const imageSha256 = sha256Hex(photo);
  if (imageSha256 !== bundle.imageSha256) {
    throw new CaptureError(400, 'hash_mismatch', 'The photo changed on the way. Take it again.');
  }

  // The same install sending the same photo again (a retry after a lost
  // answer) gets the stored answer, not a new proof and not an error.
  const earlier = await earlierResult(ctx, installId, imageSha256);
  if (earlier) return earlier;

  const image = await inspectImage(photo);
  if (!image || image.format !== 'jpeg') throw new CaptureError(400, 'bad_image', 'This file is not a camera photo.');
  if (image.width * image.height > MAX_PIXELS) throw new CaptureError(413, 'too_large', 'The photo is too large.');

  const samples = bundle.sensorData.slice(0, MAX_SENSOR_SAMPLES);
  if (!ctx.cfg.allowEmulator && ctx.checks.looksEmulated(samples, bundle.deviceInfo)) return notVerified('device');
  // A phone clock days off: say so before anything is spent (the stale-shot checks below are minutes).
  if (Math.abs(bundle.captureTimestamp - receivedAt) > 2 * DAY_MS) return notVerified('clock');

  // No hardware commitment at all (a timeout on the phone, a development
  // build): nothing to check, so nothing is stored and the nonce is kept.
  if (ctx.cfg.requireAttestation && bundle.attestation.type === 'none') {
    throw tryAgain('device_check_unavailable', 'We could not confirm this phone with Apple or Google. Try again.');
  }

  // An App Attest key the server does not know: tell the phone before the
  // nonce is spent, so it can register a new key and send again.
  if (bundle.attestation.type === 'app_attest' && ctx.cfg.appAttest.appId) {
    if (!(await appAttestKeys(ctx).get(installId, bundle.attestation.keyId))) {
      throw new CaptureError(409, 'attest_key_unknown', 'Set up the device check again.');
    }
  }

  // Single use, and only within NONCE_TTL_MS of when the upload started, so
  // a slow connection does not expire an honest capture.
  const { rows: nonceRows } = await ctx.db.query(
    `UPDATE capture_nonces SET used_at = now()
      WHERE nonce = $1 AND install_id = $2 AND used_at IS NULL AND created_at >= $3
      RETURNING nonce`,
    // created_at is written from the same app clock (routes/api.ts), so app/DB clock skew cannot move the window.
    [bundle.nonce, installId, new Date(args.requestStartedAt - NONCE_TTL_MS)],
  );
  if (nonceRows.length === 0) {
    throw new CaptureError(400, 'nonce_invalid', 'The upload took too long. Try again.');
  }

  const sensorDigest = computeSensorDigest(samples);
  const fingerprint = ctx.checks.motionFingerprint(samples);
  const replayAnswer = await refuseReplays(ctx, installId, imageSha256, sensorDigest, fingerprint, receivedAt);
  if (replayAnswer) return replayAnswer;

  let booking: { lane: DecodeLane; id: string } | null = null;
  // Only a keyed hash of the address is stored (see the privacy page).
  if (bundle.attestation.type === 'play_integrity') booking = await bookGoogleCall(ctx, installId, hmacHex(ctx.cfg.urlSecret, `gcall:${args.clientKey}`), receivedAt);

  // A booking is given back only on a known outage exit (Google throttled or
  // unavailable, a busy server, a failed vision check, a storage failure),
  // so an outage never counts against a phone. Any other error keeps it: a
  // client must not be able to cause an error and get its Google call free.
  let refund = false;
  const outage = (err: CaptureError) => {
    refund = true;
    return err;
  };
  try {
    return await (async (): Promise<CaptureResult> => {

      const bindingHash = computeBindingHash({
        installId,
        nonce: bundle.nonce,
        imageSha256,
        sensorDigest,
        deviceDigest: computeDeviceDigest(bundle.deviceInfo, bundle.captureTimestamp),
      });
      const attestation = await verifyCommitment({
        attestation: bundle.attestation,
        installId,
        bindingHash,
        appAttest: ctx.cfg.appAttest,
        keys: appAttestKeys(ctx),
        decodePlayIntegrity: ctx.decodePlayIntegrity,
        playLane: booking?.lane,
        playPackageName: ctx.cfg.playIntegrity.packageName,
        now: ctx.now(),
      });
      if (attestation.reason === 'decode_throttled') {
        throw outage(new CaptureError(429, 'device_check_busy', 'Many new phones are sending photos now. Try again in a few minutes.'));
      }
      // Apple or Google did not answer: nothing is stored, the same photo can be sent again.
      if (attestation.transient) throw outage(tryAgain('device_check_unavailable', 'We could not reach Apple or Google. Try again.'));

      const conflict = (err: unknown) => resolveConflict(ctx, installId, imageSha256, err);
      const record = (decision: Exclude<Decision, { status: 'verified' }>, analysis: PhotoAnalysis | null) =>
        ctx.db
          .query(INSERT_CAPTURE, captureRow({ id: randomUUID(), installId, receivedAt, imageSha256, sensorDigest, fingerprint, bundle, attestation, decision, analysis }))
          .then(() => notVerified(decision.reason), conflict);

      // Without a device check nothing else can make this a real proof: skip the
      // expensive work. Tampering evidence is stored as rejected.
      if (attestation.verdict === 'fail' || attestation.deviceNotCertified || (ctx.cfg.requireAttestation && !attestation.bound)) {
        const status = attestation.verdict === 'fail' || attestation.deviceNotCertified ? 'rejected' : 'not_verified';
        return record({ status, reason: 'device', detail: `attestation ${attestation.verdict}: ${attestation.reason ?? ''}` }, null);
      }

      // The motion trace is bound into the proof, so its timestamps date the shot. Without one, nothing dates it.
      const shotAt = newestSample(samples);
      if (shotAt === null) return record({ status: 'not_verified', reason: 'motion', detail: 'no motion trace' }, null);
      if (shotAt - receivedAt > MAX_CLOCK_AHEAD_MS) {
        return record({ status: 'not_verified', reason: 'clock', detail: `shot ${shotAt - receivedAt} ms ahead of server` }, null);
      }
      if (receivedAt - shotAt > MAX_SHOT_AGE_MS + MAX_CLOCK_AHEAD_MS) {
        return record({ status: 'not_verified', reason: 'stale', detail: `shot ${receivedAt - shotAt} ms before upload` }, null);
      }

      // The memory-heavy part (full decode + photo checks) runs in a bounded slot;
      // the vision call after it waits on the network, not on memory.
      let work: { images: PublicImages; analysis: PhotoAnalysis } | null;
      try {
        work = await ctx.limitVerification(async () => {
          let images: PublicImages;
          try {
            // Decoded with the publish settings first: a file that cannot be published never reaches the photo checks.
            images = await makePublicImages(photo);
          } catch {
            return null;
          }
          const analysis = await ctx.checks.analyze({
            imageBuffer: photo,
            sensorSamples: samples,
            deviceInfo: bundle.deviceInfo,
            captureTimestamp: bundle.captureTimestamp,
            receivedAt,
            attestation,
          });
          return { images, analysis };
        });
      } catch (err) {
        if (err instanceof BusyError) throw outage(tryAgain('busy', 'TrustPhoto is busy. Try again in a minute.'));
        throw err;
      }
      if (!work) return record({ status: 'not_verified', reason: 'checks', detail: 'photo could not be decoded' }, null);

      const { images, analysis } = work;
      const captureId = randomUUID();
      const screen = await screenCheckIfNeeded(ctx, captureId, images.display, analysis).catch((err: unknown) => {
        if (err instanceof StorageError) throw outage(tryAgain('storage_unavailable', 'We could not save the photo. Try again.'));
        throw err;
      });
      if (screen.failed) throw outage(tryAgain('checks_unavailable', 'We could not finish the checks. Try again.'));
      const decision = ctx.checks.decide({ analysis, attestation, requireAttestation: ctx.cfg.requireAttestation, screen });
      if (decision.status !== 'verified') return record(decision, analysis);
      return publish(ctx, { captureId, installId, receivedAt, imageSha256, sensorDigest, fingerprint, bundle, attestation, analysis, screen, images, decision }).catch(
        (err: unknown) => {
          if (err instanceof StorageError) throw outage(tryAgain('storage_unavailable', 'We could not save the photo. Try again.'));
          return conflict(err);
        },
      );
    })();
  } finally {
    if (booking && refund) await ctx.db.query('DELETE FROM device_check_attempts WHERE id = $1', [booking.id]).catch(() => undefined);
  }
}

type Refusal = 'install_failures' | 'install_day' | 'network' | 'everyone';

/** One honest message per cause: only the first is about this phone. */
const REFUSALS: Record<Refusal, () => CaptureError> = {
  install_failures: () => new CaptureError(429, 'device_check_limit', 'This phone sent too many photos that failed the device check today. Try again tomorrow.'),
  install_day: () => new CaptureError(429, 'device_check_limit', 'This phone reached the limit of photos for today. Try again tomorrow.'),
  network: () => new CaptureError(429, 'device_check_busy', 'Many phones on this network are sending photos now. Try again in an hour.'),
  everyone: () => new CaptureError(429, 'device_check_busy', 'Many new phones are sending photos today. Try again later.'),
};

/**
 * Books one Google call, or refuses with 429. One transaction under one
 * global lock: bookings are tiny, and the per-install, per-address and
 * global counts then cannot race.
 */
async function bookGoogleCall(ctx: Context, installId: string, clientKey: string, now: number): Promise<{ lane: DecodeLane; id: string }> {
  const id = randomUUID();
  const outcome = await ctx.db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('trustphoto-device-check', 0))");
    const day = new Date(now - DAY_MS);
    // Rows older than a day no longer count; clear them as we go.
    await tx.query('DELETE FROM device_check_attempts WHERE at < $1', [new Date(now - 2 * DAY_MS)]);
    // Proven means a past Play Integrity pass: an App Attest pass says nothing about Google's quota.
    const { rows: proven } = await tx.query(
      "SELECT 1 FROM captures WHERE install_id = $1 AND attestation_verdict = 'pass' AND platform = 'android' LIMIT 1",
      [installId],
    );
    const lane: DecodeLane = proven.length > 0 ? 'proven' : 'unproven';
    const { rows } = await tx.query<{ install_calls: number; address_hour: number; address_day: number; unproven_calls: number }>(
      `SELECT count(*) FILTER (WHERE install_id = $1 AND lane = $5)::int AS install_calls,
              count(*) FILTER (WHERE client_key = $2 AND lane = $5 AND at > $4)::int AS address_hour,
              count(*) FILTER (WHERE client_key = $2 AND lane = $5)::int AS address_day,
              count(*) FILTER (WHERE lane = 'unproven')::int AS unproven_calls
         FROM device_check_attempts WHERE at > $3`,
      [installId, clientKey, day, new Date(now - 3_600_000), lane],
    );
    const c = rows[0];
    const refusal: Refusal | null =
      lane === 'proven'
        ? c.install_calls >= PROVEN_CALLS_PER_INSTALL_PER_DAY
          ? 'install_day'
          : c.address_day >= PROVEN_CALLS_PER_ADDRESS_PER_DAY
            ? 'network'
            : null
        : c.install_calls >= UNPROVEN_CALLS_PER_INSTALL_PER_DAY
          ? 'install_failures'
          : c.address_hour >= UNPROVEN_CALLS_PER_ADDRESS_PER_HOUR
            ? 'network'
            : c.unproven_calls >= ctx.cfg.unprovenDailyGoogleCalls
              ? 'everyone'
              : null;
    if (refusal) return { lane, refusal };
    await tx.query('INSERT INTO device_check_attempts (id, install_id, client_key, at, lane) VALUES ($1, $2, $3, $4, $5)', [
      id,
      installId,
      clientKey,
      new Date(now),
      lane,
    ]);
    return { lane, refusal: null };
  });
  if (outcome.refusal) throw REFUSALS[outcome.refusal]();
  return { lane: outcome.lane, id };
}

/**
 * Two uploads of the same photo can race past the pre-checks; the UNIQUE
 * column decides. The loser from the same install gets the winner's answer.
 */
async function resolveConflict(ctx: Context, installId: string, imageSha256: string, err: unknown): Promise<CaptureResult> {
  try {
    duplicateOnConflict(err);
  } catch (dup) {
    if (dup instanceof CaptureError && dup.code === 'duplicate_photo') {
      const earlier = await earlierResult(ctx, installId, imageSha256);
      if (earlier) return earlier;
    }
    throw dup;
  }
}

async function publish(
  ctx: Context,
  c: {
    captureId: string;
    installId: string;
    receivedAt: number;
    imageSha256: string;
    sensorDigest: string;
    fingerprint: string | null;
    bundle: CaptureBundle;
    attestation: AttestationOutcome;
    analysis: PhotoAnalysis;
    screen: ScreenDecision;
    images: PublicImages;
    decision: Decision;
  },
): Promise<CaptureResult> {
  const id = newPhotoId();
  const row: PhotoRow = {
    id,
    install_id: c.installId,
    received_at: new Date(c.receivedAt),
    original_sha256: c.imageSha256,
    public_sha256: sha256Hex(c.images.display),
    phash: c.images.phash,
    width: c.images.width,
    height: c.images.height,
    device_label: deviceLabel(c.bundle.deviceInfo),
    checks: ctx.checks.publicChecks(c.analysis, c.attestation, c.screen),
    is_test: !c.attestation.bound,
    receipt: {},
    signature: '',
    deleted_at: null,
  };
  row.receipt = {
    type: 'trustphoto.receipt',
    v: 1,
    id,
    url: `${ctx.cfg.publicBaseUrl}/p/${id}`,
    receivedAt: new Date(c.receivedAt).toISOString(),
    originalSha256: row.original_sha256,
    publicSha256: row.public_sha256,
    phash: row.phash,
    device: row.device_label,
    checks: row.checks,
    test: row.is_test,
    keyId: ctx.signer.keyId,
  };
  row.signature = ctx.signer.sign(row.receipt);

  try {
    await Promise.all([
      ctx.storage.put(photoKeys.display(id), c.images.display, 'image/jpeg'),
      ctx.storage.put(photoKeys.preview(id), c.images.preview, 'image/jpeg'),
    ]).catch((err: unknown) => {
      throw new StorageError(err instanceof Error ? err.message : String(err));
    });
    await ctx.db.transaction(async (tx) => {
      await tx.query(INSERT_CAPTURE, captureRow({ ...c, id: c.captureId, decision: c.decision }));
      await tx.query(
        `INSERT INTO photos (id, capture_id, install_id, received_at, original_sha256, public_sha256, phash, width, height,
            device_label, checks, is_test, receipt, signature, feature_keys, feature_x, feature_y)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::int4[], $16::int2[], $17::int2[])`,
        [id, c.captureId, c.installId, row.received_at, row.original_sha256, row.public_sha256, row.phash, row.width, row.height,
          row.device_label, JSON.stringify(row.checks), row.is_test, JSON.stringify(row.receipt), row.signature, ...featureColumns(c.images.code)],
      );
    });
  } catch (err) {
    // A commit whose answer was lost still made the proof: keep its files.
    // Unknown (the database is gone too): keep the files. An orphan file is an accepted risk; a proof without its image is not.
    const committed = await ctx.db.query('SELECT 1 FROM photos WHERE id = $1', [id]).then((r) => r.rows.length > 0, () => true);
    if (!committed) await Promise.allSettled([ctx.storage.delete(photoKeys.display(id)), ctx.storage.delete(photoKeys.preview(id))]);
    throw err;
  }
  return { status: 'verified', photo: toPublicPhoto(row, ctx.cfg.publicBaseUrl) };
}

function notVerified(reason: NotVerifiedReason): CaptureResult {
  return { status: 'not_verified', reason, message: NOT_VERIFIED_MESSAGES[reason] };
}

async function earlierResult(ctx: Context, installId: string, imageSha256: string): Promise<CaptureResult | null> {
  const { rows } = await ctx.db.query<{ id: string; install_id: string; status: string; reason: NotVerifiedReason | null }>(
    'SELECT id, install_id, status, reason FROM captures WHERE image_sha256 = $1',
    [imageSha256],
  );
  const capture = rows[0];
  if (!capture) return null;
  if (capture.install_id !== installId) throw new CaptureError(409, 'duplicate_photo', 'This photo was already sent.');
  if (capture.status !== 'verified') return notVerified(capture.reason ?? 'checks');
  const photo = await findPhotoByCapture(ctx.db, capture.id);
  // Verified once, deleted by its owner since: it does not come back.
  if (!photo) throw new CaptureError(409, 'duplicate_photo', 'You deleted this photo. Take a new one.');
  return { status: 'verified', photo: toPublicPhoto(photo, ctx.cfg.publicBaseUrl) };
}

/**
 * The exact motion trace may never verify twice anywhere. The fingerprint
 * of the photo checks (when they give one) also catches a lightly changed
 * replay, but phones held still can share one, so it is checked only within
 * the same install.
 */
async function refuseReplays(
  ctx: Context,
  installId: string,
  imageSha256: string,
  sensorDigest: string,
  fingerprint: string | null,
  now: number,
): Promise<CaptureResult | null> {
  const { rows } = await ctx.db.query<{ install_id: string; image_sha256: string }>(
    `SELECT install_id, image_sha256 FROM captures
      WHERE image_sha256 = $1
         OR ($2 <> '' AND sensor_digest = $2)
         OR ($3::text IS NOT NULL AND install_id = $4 AND sensor_fingerprint = $3 AND received_at > $5)
      LIMIT 1`,
    [imageSha256, sensorDigest, fingerprint, installId, new Date(now - FINGERPRINT_FENCE_DAYS * 86_400_000)],
  );
  if (rows.length === 0) return null;
  // The same photo from the same install landed meanwhile (a retry racing the original): its answer.
  if (rows[0].image_sha256 === imageSha256 && rows[0].install_id === installId) {
    const earlier = await earlierResult(ctx, installId, imageSha256);
    if (earlier) return earlier;
  }
  throw rows[0].image_sha256 === imageSha256 ? new CaptureError(409, 'duplicate_photo', 'This photo was already sent.') : motionReplay();
}

const motionReplay = () => new CaptureError(409, 'duplicate_motion', 'This motion data was already sent. Take a new photo.');

/** Two concurrent uploads can both pass the pre-checks; the UNIQUE columns decide (named by Postgres). */
function duplicateOnConflict(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23505' && e.constraint === 'captures_image_sha256_key') {
    throw new CaptureError(409, 'duplicate_photo', 'This photo was already sent.');
  }
  if (e.code === '23505' && e.constraint === 'captures_sensor_digest_key') throw motionReplay();
  throw err;
}

function newestSample(samples: SensorSample[]): number | null {
  return samples.length === 0 ? null : samples.reduce((max, s) => Math.max(max, s.timestamp), -Infinity);
}

/**
 * The vision check runs only for a photo that would otherwise verify. The
 * provider fetches the metadata-free public copy through
 * a two-minute signed URL; the pending copy is removed right after.
 */
async function screenCheckIfNeeded(ctx: Context, captureId: string, display: Buffer, analysis: PhotoAnalysis): Promise<ScreenDecision> {
  if (!analysis.passed) return { cleared: false, flagged: false, failed: false };
  const key = photoKeys.pending(captureId);
  await ctx.storage.put(key, display, 'image/jpeg').catch((err: unknown) => {
    throw new StorageError(err instanceof Error ? err.message : String(err));
  });
  try {
    const expires = ctx.now() + 2 * 60_000;
    const sig = hmacHex(ctx.cfg.urlSecret, `${captureId}.${expires}`);
    const result = await ctx.screenCheck(`${ctx.cfg.publicBaseUrl}/v1/pending/${captureId}.jpg?exp=${expires}&sig=${sig}`);
    return ctx.checks.decideScreen(result);
  } finally {
    await ctx.storage.delete(key).catch(() => undefined);
  }
}

export function appAttestKeys(ctx: Context): AppAttestKeyStore {
  return {
    async get(installId, keyId) {
      const { rows } = await ctx.db.query<{ pem: string; count: string | number }>(
        `SELECT app_attest_public_key_pem AS pem, app_attest_sign_count AS count FROM installs
          WHERE id = $1 AND app_attest_key_id = $2 AND app_attest_public_key_pem IS NOT NULL`,
        [installId, keyId],
      );
      return rows[0] ? { publicKeyPem: rows[0].pem, signCount: Number(rows[0].count) } : null;
    },
    async advance(installId, keyId, from, to) {
      // Keyed on the key ID too: a key registered meanwhile keeps its own counter.
      const { rows } = await ctx.db.query(
        `UPDATE installs SET app_attest_sign_count = $4
          WHERE id = $1 AND app_attest_key_id = $2 AND app_attest_sign_count = $3 AND $4 > $3 RETURNING id`,
        [installId, keyId, from, to],
      );
      return rows.length === 1;
    },
  };
}

/** "Apple iPhone 15 Pro", "Samsung SM-S921B". Bound into the device check through the binding hash. */
export function deviceLabel(info: DeviceInfo): string | null {
  const clean = (s: string | null) => (s ?? '').replace(/[^\p{L}\p{N} ()+.,_-]/gu, '').trim().slice(0, 40);
  const brand = clean(info.brand);
  const model = clean(info.model);
  if (!model) return brand ? capitalize(brand) : null;
  if (!brand || model.toLowerCase().startsWith(brand.toLowerCase())) return model;
  return `${capitalize(brand)} ${model}`;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function captureRow(c: {
  id: string;
  installId: string;
  receivedAt: number;
  imageSha256: string;
  sensorDigest: string;
  fingerprint: string | null;
  bundle: CaptureBundle;
  attestation: AttestationOutcome;
  decision: Decision;
  analysis: PhotoAnalysis | null;
}): unknown[] {
  return [
    c.id,
    c.installId,
    new Date(c.receivedAt),
    c.imageSha256,
    c.sensorDigest || null,
    c.fingerprint,
    c.decision.status,
    c.decision.status === 'verified' ? null : c.decision.reason,
    c.analysis?.score ?? null,
    c.attestation.verdict,
    c.bundle.deviceInfo.platform,
    c.bundle.deviceInfo.model,
    c.bundle.deviceInfo.appVersion,
    Number.isFinite(c.bundle.captureTimestamp) ? new Date(c.bundle.captureTimestamp) : null,
    // Numbers and short notes from the checks only: never the photo or the motion trace.
    // The server's own fields come last, so a module's record cannot replace them.
    JSON.stringify({
      ...(c.analysis?.record ?? {}),
      decision: c.decision,
      attestation: { verdict: c.attestation.verdict, type: c.attestation.type, reason: c.attestation.reason, deviceNotCertified: c.attestation.deviceNotCertified },
    }),
  ];
}
