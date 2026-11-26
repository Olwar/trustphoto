import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BusyError, createConcurrencyLimit } from '../src/limits.js';
import { rateKey } from '../src/client-ip.js';
import { appAttestKeys } from '../src/services/captures.js';
import { createPlayIntegrityDecoder } from '../src/attest/play-integrity.js';
import { createSigner } from '../src/signing.js';
import { migrate, openDb } from '../src/db/index.js';
import { createHarness, createTestDatabase, playVerdict, registerInstall, sendCapture, type Harness } from './harness.js';
import { motionTrace, phonePhoto } from './fixtures.js';
import { multipart } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ REQUIRE_ATTESTATION: 'true' });
});
afterAll(async () => {
  await h.close();
});

const capturesOf = async (installId: string) =>
  (await h.ctx.db.query('SELECT 1 FROM captures WHERE install_id = $1', [installId])).rows.length;

describe('concurrency limit', () => {
  it('never runs more than its limit, also when a new caller arrives as a slot frees', async () => {
    const run = createConcurrencyLimit(2, 100);
    let active = 0;
    let peak = 0;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const task = (ms: number) => async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(ms);
      active--;
    };
    let firstTask!: Promise<void>;
    const a = run(() => (firstTask = task(10)()));
    const b = run(task(60));
    const c = run(task(30)); // waits for a slot
    // A caller whose turn comes right between "slot freed" and "waiter resumes".
    const d = firstTask.then(() => run(task(30)));
    await Promise.all([a, b, c, d]);
    expect(peak).toBe(2);
  });

  it('refuses callers past the queue limit', async () => {
    const run = createConcurrencyLimit(1, 1);
    let release!: () => void;
    const blocker = run(() => new Promise<void>((r) => (release = r)));
    const queued = run(async () => 'queued');
    await expect(run(async () => 'third')).rejects.toBeInstanceOf(BusyError);
    release();
    await blocker;
    expect(await queued).toBe('queued');
  });
});

describe('client address keys', () => {
  it('counts an IPv6 address as its /64 and keeps IPv4 as is', () => {
    expect(rateKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(rateKey('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(rateKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateKey('::ffff:192.0.2.7')).toBe('192.0.2.7');
    expect(rateKey('192.0.2.7')).toBe('192.0.2.7');
  });

  it('lets one IPv6 /64 make only 20 installs an hour', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await h.app.inject({ method: 'POST', url: '/v1/installs', payload: { platform: 'android' }, remoteAddress: `2001:db8:77:1::${(i + 1).toString(16)}` });
      statuses.push(res.statusCode);
    }
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('answers that must not be final', () => {
  it('stores nothing when Google cannot be reached, so the same photo can be sent again', async () => {
    const install = await registerInstall(h.app);
    const decode = h.ctx.decodePlayIntegrity;
    h.ctx.decodePlayIntegrity = async () => ({ ok: false, reason: 'unavailable', error: 'quota' });
    const photo = await phonePhoto(401, Date.now());
    try {
      const { res } = await sendCapture(h.app, install, { photo });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('device_check_unavailable');
      expect(await capturesOf(install.installId)).toBe(0);
    } finally {
      h.ctx.decodePlayIntegrity = decode;
    }
    expect((await sendCapture(h.app, install, { photo })).res.json()).toMatchObject({ status: 'verified' });
  });

  it('does not verify when the vision check fails, and stores nothing', async () => {
    const install = await registerInstall(h.app);
    h.screenAnswers.push({ screen: null, confidence: null, reason: null, model: 'fake', error: 'timeout' });
    const { res } = await sendCapture(h.app, install);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('checks_unavailable');
    expect(await capturesOf(install.installId)).toBe(0);
  });
});

describe('abuse of free installs', () => {
  it('never lets parallel junk uploads from one install reach Google more than its budget', async () => {
    const install = await registerInstall(h.app);
    let calls = 0;
    const decode = h.ctx.decodePlayIntegrity;
    h.ctx.decodePlayIntegrity = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return { ok: false, reason: 'invalid', error: 'junk' };
    };
    try {
      for (let round = 0; round < 4; round++) {
        await Promise.all(Array.from({ length: 8 }, () => sendCapture(h.app, install, { attestation: { type: 'play_integrity', token: 'junk' } })));
      }
    } finally {
      h.ctx.decodePlayIntegrity = decode;
    }
    expect(calls).toBeLessThanOrEqual(5);
  });

  it('limits Google calls per address for new installs, but not for a phone that passed before', async () => {
    const decode = h.ctx.decodePlayIntegrity;
    let calls = 0;
    h.ctx.decodePlayIntegrity = async (token, lane) => {
      calls++;
      return decode(token, lane);
    };
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) {
        const install = await registerInstall(h.app);
        for (let j = 0; j < 5; j++) {
          const { res } = await sendCapture(h.app, install, { attestation: { type: 'play_integrity', token: 'junk' }, remoteAddress: '198.51.100.9' });
          statuses.push(res.statusCode);
        }
      }
      // 7 installs x 5 tries = 35 tries from one address; at most 30 may reach Google in an hour.
      expect(calls).toBeLessThanOrEqual(30);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(5);
    } finally {
      h.ctx.decodePlayIntegrity = decode;
    }
  });

  it('reads the bundle before the photo, and refuses a stale nonce without buffering the file', async () => {
    const install = await registerInstall(h.app);
    const bundle = { v: 1, nonce: '00000000-0000-4000-8000-000000000000', imageSha256: 'a'.repeat(64), captureTimestamp: Date.now(), sensorData: [], deviceInfo: { platform: 'android', brand: null, model: null, osVersion: null, appVersion: null, isDevice: true, hasGyroscope: true }, attestation: { type: 'none', reason: 'x' } };
    const { payload, headers } = multipart(bundle, Buffer.alloc(8 * 1024 * 1024, 7));
    const res = await h.app.inject({ method: 'POST', url: '/v1/captures', payload, headers: { ...headers, ...install.auth } });
    expect(res.json().error.code).toBe('nonce_invalid');
    // A file before the bundle is refused.
    const photoFirst = Buffer.from(payload.toString('latin1').replace('name="bundle"', 'name="later"'), 'latin1');
    const res2 = await h.app.inject({ method: 'POST', url: '/v1/captures', payload: photoFirst, headers: { ...headers, ...install.auth } });
    expect(res2.statusCode).toBe(400);
  });

  it('stops an install that only fails the device check after 5 failures a day', async () => {
    const install = await registerInstall(h.app);
    const junk = { type: 'play_integrity' as const, token: 'not-json' };
    for (let i = 0; i < 5; i++) {
      expect((await sendCapture(h.app, install, { attestation: junk })).res.json()).toMatchObject({ status: 'not_verified', reason: 'device' });
    }
    const sixth = await sendCapture(h.app, install, { attestation: junk });
    expect(sixth.res.statusCode).toBe(429);
    expect(sixth.res.json().error.code).toBe('device_check_limit');
  });

  it('keeps a separate budget of Google calls for proven installs', async () => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      return new Response(JSON.stringify({ access_token: 't', tokenPayloadExternal: {} }));
    }) as unknown as typeof fetch;
    const sa = { client_email: 'x@y', token_uri: 'https://oauth2.test/token', private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
    const decode = createPlayIntegrityDecoder({ packageName: 'com.socialhuman.trustphoto', serviceAccount: sa }, fake, { proven: 5, unproven: 2 });
    await decode('a', 'unproven');
    await decode('b', 'unproven');
    expect(await decode('c', 'unproven')).toMatchObject({ ok: false, reason: 'throttled' });
    expect(calls).toBe(3); // one token exchange + two decodes, none for the third
    expect(await decode('d', 'proven')).toMatchObject({ ok: true });
  });
});

describe('races', () => {
  it('takes one upload per install at a time; the retry after it gets the stored proof', async () => {
    const install = await registerInstall(h.app);
    const photo = await phonePhoto(402, Date.now());
    const [a, b] = await Promise.all([sendCapture(h.app, install, { photo }), sendCapture(h.app, install, { photo })]);
    const answers = [a.res, b.res].map((r) => (r.statusCode === 200 ? 'verified' : r.json().error.code)).sort();
    expect(answers).toEqual(['install_busy', 'verified']);
    const winner = [a.res, b.res].find((r) => r.statusCode === 200)!.json().photo.id;
    expect((await sendCapture(h.app, install, { photo })).res.json()).toMatchObject({ status: 'verified', photo: { id: winner } });
  });

  it('answers a retry that raced past the first check with the stored proof, not a motion error', async () => {
    // Two instances (or a held request): B passes the "already answered?"
    // check, then A lands. B must still get A's proof.
    const install = await registerInstall(h.app);
    const takenAt = Date.now() - 500;
    const photo = await phonePhoto(403, takenAt);
    const samples = motionTrace(403, takenAt);
    const first = await sendCapture(h.app, install, { photo, samples });
    const proofId = first.res.json().photo.id;
    // B's own nonce and bundle; the stored-answer pre-check is skipped by
    // hiding A's row for exactly one lookup.
    const realQuery = h.ctx.db.query.bind(h.ctx.db);
    let hidden = false;
    h.ctx.db.query = (async (sql: string, params?: unknown[]) => {
      if (!hidden && sql.startsWith('SELECT id, install_id, status, reason FROM captures')) {
        hidden = true;
        return { rows: [] };
      }
      return realQuery(sql, params);
    }) as typeof h.ctx.db.query;
    try {
      const { res } = await sendCapture(h.app, install, { photo, samples });
      expect(res.json()).toMatchObject({ status: 'verified', photo: { id: proofId } });
    } finally {
      h.ctx.db.query = realQuery;
    }
  });

  it('moves an App Attest counter only for the key it belongs to', async () => {
    const install = await registerInstall(h.app, 'ios');
    await h.ctx.db.query("UPDATE installs SET app_attest_key_id = 'K2', app_attest_public_key_pem = 'pem', app_attest_sign_count = 0 WHERE id = $1", [install.installId]);
    const keys = appAttestKeys(h.ctx);
    expect(await keys.advance(install.installId, 'K1', 0, 1)).toBe(false);
    expect(await keys.advance(install.installId, 'K2', 0, 1)).toBe(true);
  });

  it('applies migrations once when two instances start together', async () => {
    // A fresh database, and on real Postgres two separate connections, as two server instances have.
    const fresh = await createTestDatabase();
    const first = await openDb({ dataDir: null, databaseUrl: fresh?.url });
    const second = fresh ? await openDb({ dataDir: null, databaseUrl: fresh.url }) : first;
    try {
      const [a, b] = await Promise.all([migrate(first), migrate(second)]);
      const files = (await readdir(resolve(import.meta.dirname, '../src/db/migrations'))).filter((f) => f.endsWith('.sql'));
      // Each migration ran exactly once, in one of the two instances.
      expect([...a, ...b].sort()).toEqual(files.map((f) => f.replace(/\.sql$/, '')).sort());
      expect(await migrate(first)).toEqual([]);
    } finally {
      if (second !== first) await second.close();
      await first.close();
      await fresh?.drop();
    }
  });
});

describe('signing keys', () => {
  it('publishes retired keys after the current one', () => {
    const retired = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const signer = createSigner(generateKeyPairSync('ed25519').privateKey, [retired]);
    expect(signer.publishedJwks).toHaveLength(2);
    expect(signer.publishedJwks[0]).toBe(signer.publicJwk);
  });
});

describe('Play Integrity verdict age uses the server clock', () => {
  it('refuses a verdict older than ten minutes by the server clock, even when it is fresh by the test machine clock', async () => {
    const install = await registerInstall(h.app);
    h.clock.offsetMs = 11 * 60_000;
    try {
      const { res } = await sendCapture(h.app, install, { attestation: (hash) => playVerdict(hash, { timestampMillis: Date.now() }) });
      expect(res.json()).toMatchObject({ status: 'not_verified', reason: 'device' });
    } finally {
      h.clock.offsetMs = 0;
    }
  });

  it('passes the device check with a verdict that is fresh by the server clock, even when it is old by the test machine clock', async () => {
    const install = await registerInstall(h.app);
    h.clock.offsetMs = -11 * 60_000;
    try {
      const { res } = await sendCapture(h.app, install, { attestation: (hash) => playVerdict(hash, { timestampMillis: Date.now() - 11 * 60_000 }) });
      // The device check passes; the shot itself then dates from the server's future, so the clock answer follows.
      expect(res.json()).toMatchObject({ status: 'not_verified', reason: 'clock' });
    } finally {
      h.clock.offsetMs = 0;
    }
  });
});
