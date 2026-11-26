import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MAX_PHOTO_BYTES, MAX_SENSOR_SAMPLES, NONCE_TTL_MS, SIMILAR_MAX_DISTANCE, type ApiError, type CaptureBundle, type LookupCandidate, type LookupResult } from '@trustphoto/shared';
import { frameOf, judgeBits, MAX_QUERY_KEYS, MIN_AGREEMENT, MIN_DETAIL_CELLS, unpackKeys } from '@trustphoto/shared/copycheck';
import { FEATURE_SIZE } from '@trustphoto/shared/features';
import { DETAIL_BITS_HEX, sharedGrid } from '@trustphoto/shared/match';
import type { Context } from '../context.js';
import { hmacHex, isPhotoId, newInstallToken, openLookupToken, safeEqualHex, sealLookupToken, sha256Hex } from '../ids.js';
import { CaptureError, processCapture } from '../services/captures.js';
import { deleteInstallPhoto, findPhoto, keyCandidates, listInstallPhotos, findPhotoByFile, PAGE_SIZE, phashCandidates, toPublicPhoto } from '../services/photos.js';
import { frameGray } from '../images.js';
import { BusyError, createConcurrencyLimit, createWindowLimit } from '../limits.js';
import { clientIp } from '../client-ip.js';
import { verifyKeyAttestation } from '../attest/app-attest.js';
import { photoKeys } from '../storage.js';

const CHALLENGE_TTL_MS = 60_000;
/** A lookup candidate can be confirmed for this long. */
const LOOKUP_TOKEN_TTL_MS = 5 * 60_000;

const vec = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() });
/** Text the database stores: no control characters (Postgres refuses NUL). */
const text = (max: number) => z.string().max(max).regex(/^[^\u0000-\u001f\u007f]*$/);
const bundleSchema = z.object({
  v: z.literal(1),
  nonce: z.string().uuid(),
  imageSha256: z.string().regex(/^[0-9a-f]{64}$/),
  // Any time a Date can hold (the database stores it); a wrong phone clock is answered in captures.ts.
  captureTimestamp: z.number().int().refine((t) => Math.abs(t) <= 8.64e15),
  sensorData: z.array(z.object({ accelerometer: vec, gyroscope: vec, timestamp: z.number().finite() })).max(MAX_SENSOR_SAMPLES),
  deviceInfo: z.object({
    platform: z.enum(['ios', 'android']),
    brand: text(64).nullable(),
    model: text(64).nullable(),
    osVersion: text(32).nullable(),
    appVersion: text(32).nullable(),
    isDevice: z.boolean(),
    hasGyroscope: z.boolean(),
  }),
  attestation: z.discriminatedUnion('type', [
    z.object({ type: z.literal('app_attest'), keyId: text(128).min(1), assertion: text(4096).min(1) }),
    z.object({ type: z.literal('play_integrity'), token: text(16384).min(1) }),
    z.object({ type: z.literal('none'), reason: text(64) }),
  ]),
});

declare module 'fastify' {
  interface FastifyRequest {
    install: { id: string; platform: 'ios' | 'android' } | null;
    startedAt: number;
  }
}

function apiError(reply: FastifyReply, status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return reply.code(status).send(body);
}

export function registerApi(app: FastifyInstance, ctx: Context): void {
  app.decorateRequest('install', null);
  app.decorateRequest('startedAt', 0);
  app.addHook('onRequest', async (request) => {
    request.startedAt = ctx.now();
  });

  /** Bearer <install token>. The token is stored only as a SHA-256. */
  async function requireInstall(request: FastifyRequest, reply: FastifyReply) {
    const token = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(request.headers.authorization ?? '')?.[1];
    if (token) {
      const { rows } = await ctx.db.query<{ id: string; platform: 'ios' | 'android' }>(
        'SELECT id, platform FROM installs WHERE token_hash = $1',
        [sha256Hex(token)],
      );
      if (rows[0]) {
        request.install = rows[0];
        return;
      }
    }
    return apiError(reply, 401, 'unauthorized', 'Open the app again to continue.');
  }

  /**
   * Per-install budgets, checked after authentication so a made-up token
   * gets no budget of its own. Unauthenticated routes use the per-IP plugin.
   */
  function perInstall(name: string, max: number, windowMs: number) {
    const allow = createWindowLimit(max, windowMs, ctx.now);
    return async (request: FastifyRequest, reply: FastifyReply) => {
      if (!allow(`${name}:${request.install!.id}`)) {
        return apiError(reply, 429, 'rate_limited', 'Too many requests. Wait a minute and try again.');
      }
    };
  }
  const HOUR = 3_600_000;
  const uploadsByInstall = new Set<string>();
  const uploadsByAddress = new Map<string, number>();
  /** Uploads one client address may have open at once. */
  const UPLOADS_PER_ADDRESS = 2;
  let uploadsInFlight = 0;

  type ReadResult =
    | { bundle: CaptureBundle; photo: Buffer }
    | { error: { status: number; code: string; message: string } };
  const invalid = { error: { status: 400, code: 'bad_request', message: 'The upload is not valid.' } };

  /**
   * The bundle part must come first. Its nonce is checked (not yet spent)
   * before the photo is read, so a junk upload never gets buffered.
   */
  async function readCapture(
    request: FastifyRequest,
    install: { id: string; platform: 'ios' | 'android' },
    takeSlot: () => boolean,
  ): Promise<ReadResult> {
    let bundle: CaptureBundle | null = null;
    let photo: Buffer | null = null;
    try {
      for await (const part of request.parts({ limits: { fileSize: MAX_PHOTO_BYTES, files: 1, fields: 1, fieldSize: 4 * 1024 * 1024 } })) {
        if (part.type === 'field' && part.fieldname === 'bundle' && !bundle) {
          const parsed = bundleSchema.safeParse(JSON.parse(String(part.value)));
          if (!parsed.success || parsed.data.deviceInfo.platform !== install.platform) return invalid;
          // An iPhone sends App Attest, an Android phone Play Integrity: nothing else.
          const kind = parsed.data.attestation.type;
          if ((kind === 'play_integrity' && install.platform !== 'android') || (kind === 'app_attest' && install.platform !== 'ios')) return invalid;
          bundle = parsed.data;
          const { rows } = await ctx.db.query(
            'SELECT 1 FROM capture_nonces WHERE nonce = $1 AND install_id = $2 AND used_at IS NULL AND created_at >= $3',
            [bundle.nonce, install.id, new Date(request.startedAt - NONCE_TTL_MS)],
          );
          if (rows.length === 0) return { error: { status: 400, code: 'nonce_invalid', message: 'The upload took too long. Try again.' } };
          if (!takeSlot()) return { error: { status: 503, code: 'busy', message: 'TrustPhoto is busy. Try again in a minute.' } };
        } else if (part.type === 'file' && part.fieldname === 'photo' && bundle) {
          photo = await part.toBuffer();
        } else {
          // An unread file stream stalls the parser: drain it, then refuse.
          if (part.type === 'file') part.file.resume();
          return invalid;
        }
      }
    } catch (err) {
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') return { error: { status: 413, code: 'too_large', message: 'The photo is too large.' } };
      return invalid;
    }
    return bundle && photo ? { bundle, photo } : invalid;
  }
  const attestLimit = perInstall('attest', 10, HOUR);

  app.post(
    '/v1/installs',
    // 20 an hour per address: room for people behind one carrier address, little room for minting tokens.
    { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const body = z.object({ platform: z.enum(['ios', 'android']) }).safeParse(request.body);
      if (!body.success) return apiError(reply, 400, 'bad_request', 'Unknown platform.');
      const id = randomUUID();
      const token = newInstallToken();
      await ctx.db.query('INSERT INTO installs (id, token_hash, platform) VALUES ($1, $2, $3)', [id, sha256Hex(token), body.data.platform]);
      return reply.code(201).send({ installId: id, token });
    },
  );

  app.post(
    '/v1/app-attest/challenge',
    { preHandler: [requireInstall, attestLimit] },
    async (request) => {
      const challenge = randomBytes(32).toString('base64url');
      const now = ctx.now();
      // Used and expired challenges have no further use.
      await ctx.db.query('DELETE FROM attest_challenges WHERE created_at < $1', [new Date(now - 86_400_000)]);
      await ctx.db.query('INSERT INTO attest_challenges (challenge, install_id, created_at) VALUES ($1, $2, $3)', [challenge, request.install!.id, new Date(now)]);
      return { challenge };
    },
  );

  app.post(
    '/v1/app-attest/register',
    { preHandler: [requireInstall, attestLimit] },
    async (request, reply) => {
      const body = z
        .object({ keyId: text(128).min(1), challenge: text(128).min(1), attestation: text(32768).min(1) })
        .safeParse(request.body);
      if (!body.success) return apiError(reply, 400, 'bad_request', 'The device key data is not valid.');
      const install = request.install!;
      const { rows } = await ctx.db.query(
        `UPDATE attest_challenges SET used_at = now()
          WHERE challenge = $1 AND install_id = $2 AND used_at IS NULL AND created_at >= $3 RETURNING challenge`,
        [body.data.challenge, install.id, new Date(ctx.now() - CHALLENGE_TTL_MS)],
      );
      if (rows.length === 0) return apiError(reply, 400, 'challenge_invalid', 'The device check took too long. Try again.');
      const result = await verifyKeyAttestation(ctx.cfg.appAttest, body.data.keyId, body.data.challenge, body.data.attestation);
      if (!result.ok) {
        request.log.warn({ reason: result.reason, error: result.error }, 'app attest registration failed');
        return apiError(reply, result.reason === 'misconfigured' ? 503 : 400, result.reason, 'Apple could not confirm this device.');
      }
      try {
        // A new attested key replaces the old one: after a restore to a new
        // phone the old Secure Enclave key no longer exists.
        await ctx.db.query(
          'UPDATE installs SET app_attest_key_id = $2, app_attest_public_key_pem = $3, app_attest_sign_count = $4 WHERE id = $1',
          [install.id, body.data.keyId, result.publicKeyPem, result.signCount],
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23505') return apiError(reply, 409, 'key_in_use', 'This device key is already in use.');
        throw err;
      }
      return reply.code(204).send();
    },
  );

  app.post(
    '/v1/nonce',
    { preHandler: [requireInstall, perInstall('nonce', 60, 10 * 60_000)] },
    async (request) => {
      const nonce = randomUUID();
      const now = ctx.now();
      // The app clock writes created_at and checks it (services/captures.ts): app/DB clock skew cannot move the window.
      await ctx.db.query('INSERT INTO capture_nonces (nonce, install_id, created_at) VALUES ($1, $2, $3)', [nonce, request.install!.id, new Date(now)]);
      // Spent and expired nonces, and Google-call bookings past their window, have no further use.
      await ctx.db.query('DELETE FROM capture_nonces WHERE created_at < $1', [new Date(now - 86_400_000)]);
      await ctx.db.query('DELETE FROM device_check_attempts WHERE at < $1', [new Date(now - 2 * 86_400_000)]);
      return { nonce };
    },
  );

  app.post(
    '/v1/captures',
    { preHandler: [requireInstall, perInstall('capture', 30, HOUR)] },
    async (request, reply) => {
      if (!request.isMultipart()) return apiError(reply, 400, 'bad_request', 'Send the photo as multipart form data.');
      const install = request.install!;
      // One upload at a time per install, and a cap per instance: an upload
      // holds up to 15 MB in memory until it is checked.
      const address = clientIp(request, ctx.cfg);
      if (uploadsByInstall.has(install.id)) {
        return apiError(reply, 429, 'install_busy', 'Your last photo is still being checked. Wait a moment, then try again.');
      }
      if ((uploadsByAddress.get(address) ?? 0) >= UPLOADS_PER_ADDRESS) {
        return apiError(reply, 429, 'rate_limited', 'Too many uploads at once. Wait a moment, then try again.');
      }
      uploadsByInstall.add(install.id);
      uploadsByAddress.set(address, (uploadsByAddress.get(address) ?? 0) + 1);
      // The instance-wide slot is taken only once a bundle with a live nonce has arrived,
      // so connections that send nothing (or junk) cannot hold the slots of honest uploads.
      let holdsSlot = false;
      const takeSlot = () => {
        if (uploadsInFlight >= ctx.cfg.maxUploadsInFlight) return false;
        uploadsInFlight++;
        holdsSlot = true;
        return true;
      };
      try {
        const read = await readCapture(request, install, takeSlot);
        if ('error' in read) return apiError(reply, read.error.status, read.error.code, read.error.message);
        const result = await processCapture(ctx, {
          installId: install.id,
          bundle: read.bundle,
          photo: read.photo,
          requestStartedAt: request.startedAt,
          clientKey: clientIp(request, ctx.cfg),
        });
        request.log.info({ status: result.status, reason: result.status === 'not_verified' ? result.reason : undefined }, 'capture processed');
        return result;
      } catch (err) {
        if (err instanceof CaptureError) return apiError(reply, err.status, err.code, err.message);
        throw err;
      } finally {
        uploadsByInstall.delete(install.id);
        const left = (uploadsByAddress.get(address) ?? 1) - 1;
        if (left > 0) uploadsByAddress.set(address, left);
        else uploadsByAddress.delete(address);
        if (holdsSlot) uploadsInFlight--;
      }
    },
  );

  app.get<{ Querystring: { after?: string } }>('/v1/me/photos', { preHandler: requireInstall }, async (request, reply) => {
    const after = request.query.after ?? null;
    if (after !== null && !isPhotoId(after)) return apiError(reply, 400, 'bad_request', 'Unknown page.');
    const rows = await listInstallPhotos(ctx.db, request.install!.id, after);
    return {
      photos: rows.map((r) => toPublicPhoto(r, ctx.cfg.publicBaseUrl)),
      next: rows.length === PAGE_SIZE ? rows[rows.length - 1].id : null,
    };
  });

  app.delete<{ Params: { id: string } }>('/v1/me/photos/:id', { preHandler: requireInstall }, async (request, reply) => {
    if (!isPhotoId(request.params.id)) return apiError(reply, 404, 'not_found', 'This photo does not exist.');
    const deleted = await deleteInstallPhoto(ctx, request.install!.id, request.params.id, (msg) => request.log.error(msg));
    return deleted ? reply.code(204).send() : apiError(reply, 404, 'not_found', 'This photo does not exist.');
  });

  const phashText = z.string().regex(/^[0-9a-f]{16}$/);
  /** Key searches that run at once, and that wait. More than that are refused, so lookups cannot take every database connection. */
  const limitKeySearch = createConcurrencyLimit(2, 4);
  // The keys of three sizes of the file, as base64: larger than the default body limit.
  app.post('/v1/lookup', { bodyLimit: 96 * 1024, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = z
      .object({
        v: z.literal(2).optional(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        phash: phashText.optional(),
        phashes: z.array(phashText).min(1).max(8).optional(),
        keys: z.string().min(1).max(Math.ceil((MAX_QUERY_KEYS * 4) / 3) * 4 + 4).optional(),
      })
      .refine((b) => b.sha256 || b.phash || b.phashes || b.keys)
      .safeParse(request.body);
    if (!body.success) return apiError(reply, 400, 'bad_request', 'Send a sha256, a phash or keys.');
    const sent = body.data;
    let result: LookupResult = { match: 'none' };

    const exact = sent.sha256 ? await findPhotoByFile(ctx.db, sent.sha256) : null;
    if (exact) return { match: 'exact', photo: toPublicPhoto(exact, ctx.cfg.publicBaseUrl) } satisfies LookupResult;
    // The first version of the website (it can still be in a browser's cache for an hour) sends one pHash and has
    // no confirm step. It gets the exact match only: a "looks like" answer needs the confirm step.
    if (sent.v !== 2) return result;

    // A candidate is not an answer: the browser must show, in /v1/lookup/confirm, that its file has the photo's detail.
    const keys = sent.keys ? unpackKeys(sent.keys) : null;
    if (sent.keys && (!keys || keys.length === 0 || keys.length > MAX_QUERY_KEYS)) return apiError(reply, 400, 'bad_request', 'The keys are not valid.');
    const expiresAt = ctx.now() + LOOKUP_TOKEN_TTL_MS;
    const candidate = (row: { id: string; width: number; height: number }): LookupCandidate => ({
      token: sealLookupToken(ctx.cfg.urlSecret, row.id, expiresAt),
      ...frameOf(row.width, row.height),
    });
    const candidates: LookupCandidate[] = [];
    if (sent.phashes) {
      for (const found of await phashCandidates(ctx.db, sent.phashes, SIMILAR_MAX_DISTANCE)) candidates.push({ ...candidate(found.row), orientation: found.orientation });
    }
    if (keys) {
      // The search reads every photo's keys: few at a time, and a failure is an error for the user, never "no proof".
      let found: Awaited<ReturnType<typeof keyCandidates>>;
      try {
        found = await limitKeySearch(() => keyCandidates(ctx.db, keys));
      } catch (err) {
        if (!(err instanceof BusyError)) request.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'key search failed');
        return apiError(reply, 503, 'busy', 'TrustPhoto is busy. Try again in a minute.');
      }
      for (const { row, spots } of found) candidates.push({ ...candidate(row), spots });
    }
    if (candidates.length > 0) result = { match: 'candidates', candidates };
    return result;
  });

  /**
   * The second step of a lookup. The browser sends one bit of fine detail for
   * each cell of the part that its file shares with the candidate; the server
   * compares them with the stored photo. Only a file that has the photo's
   * detail gets the proof, so a candidate token alone shows nothing.
   */
  app.post('/v1/lookup/confirm', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const side = z.number().int().min(1).max(FEATURE_SIZE);
    const part = z.number().finite().min(-100_000).max(100_000);
    const body = z
      .object({
        token: z.string().min(1).max(256),
        frame: z.object({ width: side, height: side }),
        transform: z.object({ a: part, b: part, tx: part, ty: part }),
        bits: z.string().regex(DETAIL_BITS_HEX),
      })
      .safeParse(request.body);
    if (!body.success) return apiError(reply, 400, 'bad_request', 'The request is not valid.');
    const none: LookupResult = { match: 'none' };
    const id = openLookupToken(ctx.cfg.urlSecret, body.data.token, ctx.now());
    const row = id ? await findPhoto(ctx.db, id) : null;
    // The geometry first: a transform that shows no usable part of the photo needs no file read and no decode.
    if (!row || !sharedGrid(body.data.transform, body.data.frame, frameOf(row.width, row.height))) return none;
    const preview = await ctx.storage.get(photoKeys.preview(row.id));
    if (!preview) return none;
    const judged = judgeBits(await frameGray(preview, row.width, row.height), body.data.bits, body.data.transform, body.data.frame);
    // Too little clear detail to decide (a plain wall, a clear sky): the browser says so, in place of "no proof".
    if (!judged.match || !judged.shape) return judged.cells >= 20 && judged.cells < MIN_DETAIL_CELLS && judged.agreement >= MIN_AGREEMENT ? { ...none, unclear: true } : none;
    return { match: 'similar', photo: toPublicPhoto(row, ctx.cfg.publicBaseUrl), shape: judged.shape } satisfies LookupResult;
  });

  app.post<{ Params: { id: string } }>(
    '/v1/photos/:id/report',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const body = z
        .object({
          reason: z.enum(['not_real', 'private', 'offensive', 'other']),
          // Free text from anyone: line breaks only, no other control characters (C0, DEL, C1).
          details: z.string().trim().max(500).regex(/^[^\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]*$/).optional(),
        })
        .safeParse(request.body);
      if (!body.success) return apiError(reply, 400, 'bad_request', 'Choose a reason.');
      if (!isPhotoId(request.params.id) || !(await findPhoto(ctx.db, request.params.id))) {
        return apiError(reply, 404, 'not_found', 'This photo does not exist.');
      }
      await ctx.db.query(
        'INSERT INTO reports (id, photo_id, reason, details, reporter_hash) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (photo_id, reporter_hash) DO NOTHING',
        [randomUUID(), request.params.id, body.data.reason, body.data.details || null, hmacHex(ctx.cfg.urlSecret, `report:${clientIp(request, ctx.cfg)}`)],
      );
      request.log.warn({ photoId: request.params.id, reason: body.data.reason }, 'photo reported');
      return reply.code(204).send();
    },
  );

  /** Short-lived signed URL the screen-check provider fetches. */
  // The vision provider fetches from shared addresses; the signed URL is the guard here.
  app.get<{ Params: { file: string }; Querystring: { exp?: string; sig?: string } }>('/v1/pending/:file', { config: { rateLimit: false } }, async (request, reply) => {
    const captureId = /^([0-9a-f-]{36})\.jpg$/.exec(request.params.file)?.[1];
    const exp = Number(request.query.exp);
    const sig = request.query.sig ?? '';
    if (!captureId || !Number.isFinite(exp) || exp < ctx.now() || !/^[0-9a-f]{64}$/.test(sig) || !safeEqualHex(sig, hmacHex(ctx.cfg.urlSecret, `${captureId}.${exp}`))) {
      return apiError(reply, 404, 'not_found', 'Not found.');
    }
    const body = await ctx.storage.get(photoKeys.pending(captureId));
    if (!body) return apiError(reply, 404, 'not_found', 'Not found.');
    return reply.type('image/jpeg').header('Cache-Control', 'no-store').send(body);
  });
}
