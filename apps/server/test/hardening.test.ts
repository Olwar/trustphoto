import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { createPlayIntegrityDecoder } from '../src/attest/play-integrity.js';
import { createWindowLimit } from '../src/limits.js';
import { createHarness, getNonce, multipart, playVerdict, registerInstall, sendCapture, type Harness } from './harness.js';
import { makeAppAttestKey } from './appattest.js';
import { motionTrace } from './fixtures.js';

const APP_ID = 'TEAMID.com.socialhuman.trustphoto';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ REQUIRE_ATTESTATION: 'true', APP_ATTEST_APP_ID: APP_ID });
});
afterAll(async () => {
  await h.close();
});

async function iosInstall() {
  const install = await registerInstall(h.app, 'ios');
  const key = makeAppAttestKey(APP_ID);
  const keyId = `key-${install.installId}`;
  await h.ctx.db.query('UPDATE installs SET app_attest_key_id = $2, app_attest_public_key_pem = $3, app_attest_sign_count = 0 WHERE id = $1', [
    install.installId,
    keyId,
    key.publicKeyPem,
  ]);
  return { install, key, keyId };
}

const ios = { platform: 'ios' as const, brand: 'Apple', model: 'iPhone 15 Pro' };

describe('App Attest, end to end with the real verifier', () => {
  it('verifies an assertion over the binding hash and moves the counter forward', async () => {
    const { install, key, keyId } = await iosInstall();
    const { res } = await sendCapture(h.app, install, { deviceInfo: ios, attestation: (hash) => ({ type: 'app_attest', keyId, assertion: key.assert(hash, 1) }) });
    expect(res.json()).toMatchObject({ status: 'verified', photo: { isTest: false, device: 'Apple iPhone 15 Pro' } });
    const { rows } = await h.ctx.db.query<{ n: string }>('SELECT app_attest_sign_count AS n FROM installs WHERE id = $1', [install.installId]);
    expect(Number(rows[0].n)).toBe(1);
  });

  it('rejects a counter that does not move forward (a cloned key)', async () => {
    const { install, key, keyId } = await iosInstall();
    await sendCapture(h.app, install, { deviceInfo: ios, attestation: (hash) => ({ type: 'app_attest', keyId, assertion: key.assert(hash, 5) }) });
    const { res } = await sendCapture(h.app, install, { deviceInfo: ios, attestation: (hash) => ({ type: 'app_attest', keyId, assertion: key.assert(hash, 5) }) });
    expect(res.json()).toMatchObject({ status: 'not_verified', reason: 'device' });
    const { rows } = await h.ctx.db.query<{ status: string }>(
      "SELECT status FROM captures WHERE install_id = $1 AND result->'attestation'->>'reason' = 'counter_regression'",
      [install.installId],
    );
    expect(rows.map((r) => r.status)).toEqual(['rejected']);
  });

  it('rejects phone details changed after the key signed them', async () => {
    const { install, key, keyId } = await iosInstall();
    const { res } = await sendCapture(h.app, install, {
      deviceInfo: ios,
      tamperDeviceInfo: { brand: 'Example News', model: 'Example Staff Camera' },
      attestation: (hash) => ({ type: 'app_attest', keyId, assertion: key.assert(hash, 1) }),
    });
    expect(res.json()).toMatchObject({ status: 'not_verified', reason: 'device' });
  });

  it('asks the phone to set up its key again before it spends the nonce', async () => {
    const install = await registerInstall(h.app, 'ios');
    const nonce = await getNonce(h.app, install.auth);
    const { res } = await sendCapture(h.app, install, { nonce, deviceInfo: ios, attestation: { type: 'app_attest', keyId: 'gone', assertion: 'AAAA' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('attest_key_unknown');
    const { rows } = await h.ctx.db.query('SELECT used_at FROM capture_nonces WHERE nonce = $1', [nonce]);
    expect(rows[0]).toEqual({ used_at: null });
  });
});

describe('cost and abuse', () => {
  it('skips the photo checks and the vision check when the device check fails', async () => {
    const install = await registerInstall(h.app);
    h.screenAnswers.length = 0;
    h.screenAnswers.push({ screen: false, confidence: 0.99, reason: null, model: 'canary' });
    const checks = h.ctx.checks;
    let analyzed = 0;
    h.ctx.checks = { ...checks, analyze: (input) => (analyzed++, checks.analyze(input)) };
    try {
      const { res } = await sendCapture(h.app, install, { attestation: (hash) => playVerdict(hash, { appRecognitionVerdict: 'UNRECOGNIZED_VERSION' }) });
      expect(res.json()).toMatchObject({ status: 'not_verified', reason: 'device' });
      expect(analyzed).toBe(0);
      expect(h.screenAnswers).toHaveLength(1); // not consumed
    } finally {
      h.ctx.checks = checks;
      h.screenAnswers.length = 0;
    }
  });

  it('refuses a photo over 50 megapixels before decoding it', async () => {
    const install = await registerInstall(h.app);
    const huge = await sharp({ create: { width: 8000, height: 7000, channels: 3, background: '#888' } }).jpeg({ quality: 10 }).toBuffer();
    const { res } = await sendCapture(h.app, install, { photo: huge });
    expect(res.statusCode).toBe(413);
  });

  it('refuses a file that is not a JPEG', async () => {
    const install = await registerInstall(h.app);
    const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#888' } }).png().toBuffer();
    const { res } = await sendCapture(h.app, install, { photo: png });
    expect(res.json().error.code).toBe('bad_image');
  });

  it('answers at once when a multipart upload carries an unknown file', async () => {
    const install = await registerInstall(h.app);
    const { payload, headers } = multipart({ v: 1 }, Buffer.alloc(4 * 1024 * 1024, 1));
    const odd = Buffer.from(payload.toString('latin1').replace('name="photo"', 'name="other"'), 'latin1');
    const res = await h.app.inject({ method: 'POST', url: '/v1/captures', payload: odd, headers: { ...headers, ...install.auth } });
    expect(res.statusCode).toBe(400);
  });

  it('does not let a forged X-Forwarded-For header reset the per-address limit', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/installs',
        payload: { platform: 'android' },
        remoteAddress: '192.0.2.77',
        headers: { 'x-forwarded-for': `198.51.100.${i}` },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.filter((s) => s === 201)).toHaveLength(20);
    expect(statuses.at(-1)).toBe(429);
  });

  it('a window limit counts each key on its own, and opens again after the window', () => {
    let t = 0;
    const allow = createWindowLimit(2, 1000, () => t);
    expect([allow('a'), allow('a'), allow('a'), allow('b')]).toEqual([true, true, false, true]);
    t = 1001;
    expect(allow('a')).toBe(true);
  });
});

describe('shot time', () => {
  it('refuses a shot whose motion ended long before the upload', async () => {
    const install = await registerInstall(h.app);
    const { res } = await sendCapture(h.app, install, { samples: motionTrace(31, Date.now() - 20 * 60_000) });
    expect(res.json()).toMatchObject({ status: 'not_verified', reason: 'stale' });
  });

  it('refuses a shot from a phone clock far ahead of the server', async () => {
    const install = await registerInstall(h.app);
    const { res } = await sendCapture(h.app, install, { samples: motionTrace(32, Date.now() + 10 * 60_000) });
    expect(res.json()).toMatchObject({ status: 'not_verified', reason: 'clock' });
  });
});

describe('owner list and delete', () => {
  it('pages through the photos with a stable cursor', async () => {
    const install = await registerInstall(h.app);
    await sendCapture(h.app, install);
    const first = (await h.app.inject({ method: 'GET', url: '/v1/me/photos', headers: install.auth })).json();
    expect(first.photos).toHaveLength(1);
    expect(first.next).toBeNull();
    const bad = await h.app.inject({ method: 'GET', url: '/v1/me/photos?after=../../x', headers: install.auth });
    expect(bad.statusCode).toBe(400);
  });

  it('deletes the proof even when the file storage fails', async () => {
    const install = await registerInstall(h.app);
    const body = (await sendCapture(h.app, install)).res.json();
    const realDelete = h.ctx.storage.delete;
    h.ctx.storage.delete = async () => {
      throw new Error('bucket down');
    };
    try {
      const res = await h.app.inject({ method: 'DELETE', url: `/v1/me/photos/${body.photo.id}`, headers: install.auth });
      expect(res.statusCode).toBe(204);
      expect((await h.app.inject({ method: 'GET', url: `/p/${body.photo.id}` })).statusCode).toBe(404);
    } finally {
      h.ctx.storage.delete = realDelete;
    }
  });
});

describe('Play Integrity decoder answers', () => {
  const sa = { client_email: 'x@y.iam.gserviceaccount.com', token_uri: 'https://oauth2.test/token', private_key: '' };
  beforeAll(async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    sa.private_key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  });

  function decoderAnswering(status: number) {
    const calls: string[] = [];
    const fake = (async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).startsWith('https://oauth2.test')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
      return new Response(status === 200 ? JSON.stringify({ tokenPayloadExternal: {} }) : 'no', { status });
    }) as typeof fetch;
    return { decode: createPlayIntegrityDecoder({ packageName: 'com.socialhuman.trustphoto', serviceAccount: sa }, fake), calls };
  }

  it('treats only 400 as a rejected token', async () => {
    expect(await decoderAnswering(400).decode('t')).toMatchObject({ ok: false, reason: 'invalid' });
    for (const status of [403, 429, 500]) {
      expect(await decoderAnswering(status).decode('t')).toMatchObject({ ok: false, reason: 'unavailable' });
    }
  });

  it('gets a new access token after a 401', async () => {
    const { decode, calls } = decoderAnswering(401);
    await decode('t');
    await decode('t');
    expect(calls.filter((c) => c.startsWith('https://oauth2.test'))).toHaveLength(2);
  });
});
