import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicKey, verify } from 'node:crypto';
import sharp from 'sharp';
import exifr from 'exifr';
import type { CaptureResult, LookupResult, PublicPhoto } from '@trustphoto/shared';
import { canonicalJson } from '../src/signing.js';
import { hmacHex, sha256Hex } from '../src/ids.js';
import { photoKeys } from '../src/storage.js';
import { phashOf } from '../src/images.js';
import { BASE_URL, createHarness, getNonce, playVerdict, registerInstall, sendCapture, type Harness } from './harness.js';
import { motionTrace, phonePhoto } from './fixtures.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ REQUIRE_ATTESTATION: 'true' });
});
afterAll(async () => {
  await h.close();
});

async function verifiedPhoto(): Promise<{ photo: PublicPhoto; original: Buffer; install: Awaited<ReturnType<typeof registerInstall>> }> {
  const install = await registerInstall(h.app);
  const { res, photo } = await sendCapture(h.app, install);
  expect(res.statusCode).toBe(200);
  const body = res.json() as CaptureResult;
  if (body.status !== 'verified') throw new Error(`expected verified, got ${JSON.stringify(body)}`);
  return { photo: body.photo, original: photo, install };
}

describe('capture → proof', () => {
  it('verifies a capture with a genuine device verdict and publishes a proof', async () => {
    const { photo } = await verifiedPhoto();
    expect(photo.url).toBe(`${BASE_URL}/p/${photo.id}`);
    expect(photo.isTest).toBe(false);
    expect(photo.device).toBe('Google Pixel 8');
    expect(photo.checks.find((c) => c.key === 'device')?.state).toBe('passed');

    const page = await h.app.inject({ method: 'GET', url: `/p/${photo.id}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('A phone camera took this photo.');
    expect(page.body).toContain(`<meta property="og:image" content="${BASE_URL}/i/${photo.id}/preview.jpg">`);
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
  });

  it('serves the public copy upright and without any metadata, so no GPS', async () => {
    const { photo, original } = await verifiedPhoto();
    expect((await exifr.gps(original))?.latitude).toBeCloseTo(60.1667, 3);
    const image = await h.app.inject({ method: 'GET', url: `/i/${photo.id}.jpg` });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/jpeg');
    expect(await exifr.parse(image.rawPayload, true)).toBeUndefined();
    const meta = await sharp(image.rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([1600, 1200]);
  });

  it('signs a receipt that checks against the published key', async () => {
    const { photo, original } = await verifiedPhoto();
    const { receipt, signature } = (await h.app.inject({ method: 'GET', url: `/p/${photo.id}/receipt.json` })).json();
    const { keys } = (await h.app.inject({ method: 'GET', url: '/.well-known/trustphoto-keys.json' })).json();
    const key = createPublicKey({ key: keys[0], format: 'jwk' });
    expect(verify(null, Buffer.from(canonicalJson(receipt)), key, Buffer.from(signature, 'base64url'))).toBe(true);
    expect(receipt.originalSha256).toBe(sha256Hex(original));
    expect(verify(null, Buffer.from(canonicalJson({ ...receipt, test: true })), key, Buffer.from(signature, 'base64url'))).toBe(false);
  });

  it('marks a proof without a device check as a test proof when attestation is not required', async () => {
    const dev = await createHarness();
    try {
      const install = await registerInstall(dev.app);
      const { res } = await sendCapture(dev.app, install, { attestation: { type: 'none', reason: 'dev_build' } });
      const body = res.json() as CaptureResult;
      expect(body.status).toBe('verified');
      if (body.status !== 'verified') return;
      expect(body.photo.isTest).toBe(true);
      expect(body.photo.checks.find((c) => c.key === 'device')?.state).toBe('inconclusive');
      const page = await dev.app.inject({ method: 'GET', url: `/p/${body.photo.id}` });
      expect(page.body).toContain('This is not a real proof.');
    } finally {
      await dev.close();
    }
  });
});

describe('device check', () => {
  it('asks the phone to try again, and stores nothing, when it sent no device check', async () => {
    const install = await registerInstall(h.app);
    const { res } = await sendCapture(h.app, install, { attestation: { type: 'none', reason: 'android_token_failed' } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('device_check_unavailable');
    expect((await h.ctx.db.query('SELECT 1 FROM captures WHERE install_id = $1', [install.installId])).rows).toHaveLength(0);
  });

  it('rejects a verdict over other bytes (the photo or motion changed after the shot)', async () => {
    const install = await registerInstall(h.app);
    const { res } = await sendCapture(h.app, install, { attestation: () => playVerdict('0'.repeat(64)) });
    expect(res.json()).toMatchObject({ status: 'not_verified', reason: 'device' });
    const { rows } = await h.ctx.db.query<{ status: string }>("SELECT status FROM captures WHERE result->'attestation'->>'reason' = 'binding_mismatch'");
    expect(rows.map((r) => r.status)).toContain('rejected');
  });

  it('rejects a phone Google does not certify', async () => {
    const install = await registerInstall(h.app);
    const { res } = await sendCapture(h.app, install, {
      attestation: (hash) => playVerdict(hash, { deviceRecognitionVerdict: [] }),
    });
    expect(res.json()).toMatchObject({ status: 'not_verified', reason: 'device' });
  });
});

describe('replay and tampering', () => {
  it('accepts each nonce once', async () => {
    const install = await registerInstall(h.app);
    const nonce = await getNonce(h.app, install.auth);
    expect((await sendCapture(h.app, install, { nonce })).res.statusCode).toBe(200);
    const again = await sendCapture(h.app, install, { nonce });
    expect(again.res.statusCode).toBe(400);
    expect(again.res.json().error.code).toBe('nonce_invalid');
  });

  it('refuses an expired nonce', async () => {
    const install = await registerInstall(h.app);
    const nonce = await getNonce(h.app, install.auth);
    h.clock.offsetMs = 31_000;
    try {
      const { res } = await sendCapture(h.app, install, { nonce });
      expect(res.json().error.code).toBe('nonce_invalid');
    } finally {
      h.clock.offsetMs = 0;
    }
  });

  it('refuses a nonce issued to another install', async () => {
    const a = await registerInstall(h.app);
    const b = await registerInstall(h.app);
    const { res } = await sendCapture(h.app, b, { nonce: await getNonce(h.app, a.auth) });
    expect(res.json().error.code).toBe('nonce_invalid');
  });

  it('answers a retry of the same photo with the stored proof, and refuses it from another install', async () => {
    const install = await registerInstall(h.app);
    const first = await sendCapture(h.app, install, { seed: 101 });
    const proof = (first.res.json() as Extract<CaptureResult, { status: 'verified' }>).photo;
    const retry = await sendCapture(h.app, install, { photo: first.photo });
    expect(retry.res.json()).toMatchObject({ status: 'verified', photo: { id: proof.id } });
    const { rows } = await h.ctx.db.query('SELECT 1 FROM photos WHERE original_sha256 = $1', [sha256Hex(first.photo)]);
    expect(rows).toHaveLength(1);

    const other = await registerInstall(h.app);
    const stolen = await sendCapture(h.app, other, { photo: first.photo });
    expect(stolen.res.statusCode).toBe(409);
    expect(stolen.res.json().error.code).toBe('duplicate_photo');
  });

  it('refuses a replayed motion trace under a new photo', async () => {
    const install = await registerInstall(h.app);
    const first = await sendCapture(h.app, install, { seed: 202 });
    expect(first.res.statusCode).toBe(200);
    const again = await sendCapture(h.app, install, { seed: 203, samples: first.samples });
    expect(again.res.statusCode).toBe(409);
    expect(again.res.json().error.code).toBe('duplicate_motion');
  });

  it('refuses a photo whose bytes do not match the hash the phone committed to', async () => {
    const install = await registerInstall(h.app);
    const { res } = await sendCapture(h.app, install, { imageSha256: 'f'.repeat(64) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('hash_mismatch');
  });

  it('requires an install token', async () => {
    expect((await h.app.inject({ method: 'POST', url: '/v1/nonce' })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'POST', url: '/v1/nonce', headers: { authorization: 'Bearer nope-nope-nope-nope-nope' } })).statusCode).toBe(401);
  });
});

describe('check outcomes', () => {
  it('does not verify a capture with no motion trace, whatever the photo checks say', async () => {
    const install = await registerInstall(h.app);
    const checks = h.ctx.checks;
    let analyzed = 0;
    h.ctx.checks = { ...checks, analyze: (input) => (analyzed++, checks.analyze(input)) };
    try {
      const { res } = await sendCapture(h.app, install, { samples: [] });
      expect(res.json()).toMatchObject({ status: 'not_verified', reason: 'motion' });
      expect(analyzed).toBe(0);
    } finally {
      h.ctx.checks = checks;
    }
  });

  it('does not verify when too little motion data arrived', async () => {
    const install = await registerInstall(h.app);
    const { res } = await sendCapture(h.app, install, { samples: motionTrace(9, Date.now(), 5) });
    expect(res.json()).toMatchObject({ status: 'not_verified', reason: 'motion' });
  });

  it('does not verify when the vision check is sure the photo shows a screen', async () => {
    const install = await registerInstall(h.app);
    h.screenAnswers.push({ screen: true, confidence: 0.92, reason: 'monitor', model: 'fake' });
    const { res } = await sendCapture(h.app, install);
    expect(res.json()).toMatchObject({ status: 'not_verified', reason: 'screen' });
  });
});

describe('check a photo', () => {
  async function lookup(body: object): Promise<LookupResult> {
    return (await h.app.inject({ method: 'POST', url: '/v1/lookup', payload: body })).json();
  }

  it('finds the proof from the original file and from the public copy', async () => {
    const { photo, original } = await verifiedPhoto();
    expect(await lookup({ sha256: sha256Hex(original) })).toMatchObject({ match: 'exact', photo: { id: photo.id } });
    const copy = (await h.app.inject({ method: 'GET', url: `/i/${photo.id}.jpg` })).rawPayload;
    expect(await lookup({ sha256: sha256Hex(copy) })).toMatchObject({ match: 'exact', photo: { id: photo.id } });
  });

  it('gives a changed copy no answer without the confirm step (the first website version sent one pHash)', async () => {
    // The answer for a changed copy needs /v1/lookup/confirm: see copycheck.test.ts.
    const { original } = await verifiedPhoto();
    const reposted = await sharp(original).resize({ width: 1080 }).jpeg({ quality: 70 }).toBuffer();
    expect(await lookup({ sha256: sha256Hex(reposted), phash: await phashOf(reposted) })).toEqual({ match: 'none' });
    expect(await lookup({ phash: await phashOf(original) })).toEqual({ match: 'none' });
  });

  it('finds nothing for an unknown photo', async () => {
    const other = await phonePhoto(999_999, Date.now());
    expect(await lookup({ sha256: sha256Hex(other), phash: 'ffffffffffffffff' })).toEqual({ match: 'none' });
  });

  it('rejects a malformed query', async () => {
    expect((await h.app.inject({ method: 'POST', url: '/v1/lookup', payload: { phash: 'xyz' } })).statusCode).toBe(400);
  });
});

describe('owner and reports', () => {
  it('lists and deletes the owner’s photos; others cannot delete them', async () => {
    const { photo, install } = await verifiedPhoto();
    const list = (await h.app.inject({ method: 'GET', url: '/v1/me/photos', headers: install.auth })).json();
    expect(list.photos.map((p: PublicPhoto) => p.id)).toContain(photo.id);

    const stranger = await registerInstall(h.app);
    expect((await h.app.inject({ method: 'DELETE', url: `/v1/me/photos/${photo.id}`, headers: stranger.auth })).statusCode).toBe(404);

    expect((await h.app.inject({ method: 'DELETE', url: `/v1/me/photos/${photo.id}`, headers: install.auth })).statusCode).toBe(204);
    expect((await h.app.inject({ method: 'GET', url: `/p/${photo.id}` })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: `/i/${photo.id}.jpg` })).statusCode).toBe(404);
  });

  it('takes one report per reporter and photo', async () => {
    const { photo } = await verifiedPhoto();
    const send = () => h.app.inject({ method: 'POST', url: `/v1/photos/${photo.id}/report`, payload: { reason: 'not_real' } });
    expect((await send()).statusCode).toBe(204);
    expect((await send()).statusCode).toBe(204);
    const { rows } = await h.ctx.db.query('SELECT 1 FROM reports WHERE photo_id = $1', [photo.id]);
    expect(rows).toHaveLength(1);
    expect((await h.app.inject({ method: 'POST', url: `/v1/photos/${photo.id}/report`, payload: { reason: 'spam' } })).statusCode).toBe(400);
  });

  it('serves a pending photo only with a valid, fresh signature', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    await h.ctx.storage.put(photoKeys.pending(id), Buffer.from('jpeg bytes'), 'image/jpeg');
    const url = (exp: number, sig = hmacHex(h.ctx.cfg.urlSecret, `${id}.${exp}`)) => `/v1/pending/${id}.jpg?exp=${exp}&sig=${sig}`;
    const fresh = h.ctx.now() + 60_000;
    const ok = await h.app.inject({ method: 'GET', url: url(fresh) });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('jpeg bytes');
    expect((await h.app.inject({ method: 'GET', url: url(fresh, 'a'.repeat(64)) })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: url(h.ctx.now() - 1000) })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: url(fresh + 1, hmacHex(h.ctx.cfg.urlSecret, `${id}.${fresh}`)) })).statusCode).toBe(404);
    await h.ctx.storage.delete(photoKeys.pending(id));
  });
});

describe('pages', () => {
  it('renders home, privacy and a 404 page', async () => {
    const home = await h.app.inject({ method: 'GET', url: '/' });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('Proof that a phone took the photo.');
    expect((await h.app.inject({ method: 'GET', url: '/privacy' })).statusCode).toBe(200);
    const missing = await h.app.inject({ method: 'GET', url: '/p/AAAAAAAAAAAA' });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain('This proof is not available.');
    expect((await h.app.inject({ method: 'GET', url: '/assets/styles.css' })).statusCode).toBe(200);
  });
});
