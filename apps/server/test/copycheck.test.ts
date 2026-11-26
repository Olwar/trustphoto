/**
 * "Check a photo" for copies that are not the same file: the whole flow that
 * the website runs (packages/shared/src/copycheck.ts `checkFile`) against the real server
 * over its two lookup routes. Only the decoder differs: sharp here, a canvas
 * in the browser.
 */

import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lumaGrid, phashFromLuma, type CaptureResult, type LookupResult, type PublicPhoto } from '@trustphoto/shared';
import { checkFile, frameOf, judgeBits, MAX_QUERY_KEYS, MIN_DETAIL_CELLS, packKeys, queryBits, queryFrame, type CheckOutcome } from '@trustphoto/shared/copycheck';
import { FEATURE_INPUT_MAX, grayFromPixels, type Gray } from '@trustphoto/shared/features';
import { sha256Hex } from '../src/ids.js';
import { frameGray, makePublicImages } from '../src/images.js';
import { featureColumns } from '../src/services/photos.js';
import { photoKeys } from '../src/storage.js';
import { createHarness, registerInstall, sendCapture, type Harness } from './harness.js';
import { busyScene } from './scene.js';

let h: Harness;
let photo: PublicPhoto;
let original: Buffer;
let other: PublicPhoto;
let otherOriginal: Buffer;

async function publish(seed: number): Promise<{ photo: PublicPhoto; original: Buffer; install: Awaited<ReturnType<typeof registerInstall>> }> {
  const install = await registerInstall(h.app);
  const takenAt = Date.now() - 800;
  const { res, photo: sent } = await sendCapture(h.app, install, { photo: await busyScene(seed, takenAt), captureTimestamp: takenAt, seed });
  const body = res.json() as CaptureResult;
  if (body.status !== 'verified') throw new Error(`expected verified, got ${JSON.stringify(body)}`);
  return { photo: body.photo, original: sent, install };
}

beforeAll(async () => {
  h = await createHarness();
  ({ photo, original } = await publish(11));
  ({ photo: other, original: otherOriginal } = await publish(12));
  for (const seed of [13, 14, 15]) await publish(seed);
});
afterAll(async () => {
  await h.close();
});

/** Everything the browser sent, so a test can say what left the device. */
interface Sent {
  path: string;
  body: Record<string, unknown>;
  answer: LookupResult;
}

let checks = 0;

async function check(file: Buffer): Promise<CheckOutcome & { sent: Sent[] }> {
  const sent: Sent[] = [];
  // Each check from its own address: the lookup route permits 60 calls a minute from one address.
  const remoteAddress = `10.66.${Math.floor(checks / 250)}.${(checks++ % 250) + 1}`;
  const outcome = await checkFile(
    {
      sha256: sha256Hex(file),
      luma: lumaGrid((await sharp(file).rotate().resize(32, 32, { fit: 'fill' }).removeAlpha().raw().toBuffer()), 3),
      full: () => grayOf(file),
    },
    async (path, body) => {
      const res = await h.app.inject({ method: 'POST', url: path, payload: body as object, remoteAddress });
      if (res.statusCode !== 200) throw new Error(`${path}: ${res.statusCode} ${res.body}`);
      const answer = res.json() as LookupResult;
      sent.push({ path, body: body as Record<string, unknown>, answer });
      return answer;
    },
  );
  return { ...outcome, sent };
}

async function grayOf(file: Buffer): Promise<Gray> {
  const { data, info } = await sharp(file)
    .rotate()
    .resize({ width: FEATURE_INPUT_MAX, height: FEATURE_INPUT_MAX, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return grayFromPixels(data, info.width, info.height, 3);
}

const cut = (image: Buffer, left: number, top: number, right: number, bottom: number) =>
  sharp(image)
    .extract({ left: Math.round(1600 * left), top: Math.round(1200 * top), width: Math.round(1600 * (1 - left - right)), height: Math.round(1200 * (1 - top - bottom)) })
    .jpeg({ quality: 85 })
    .toBuffer();

describe('a changed copy of a verified photo', () => {
  it('a resized, re-compressed copy: found by the quick steps, with no search keys sent', async () => {
    const result = await check(await sharp(original).resize({ width: 680 }).jpeg({ quality: 80 }).toBuffer());
    expect(result).toMatchObject({ mirrored: false, result: { match: 'similar', photo: { id: photo.id }, shape: { rotation: 0 } } });
    if (result.result.match !== 'similar') return;
    expect(result.result.shape!.ofPhoto).toBeGreaterThan(0.97);
    expect(result.result.shape!.ofFile).toBeGreaterThan(0.97);
    expect(result.sent.some((s) => 'keys' in s.body)).toBe(false);
  });

  it('a crop of one quarter of the photo', async () => {
    const result = await check(await cut(original, 0.25, 0.25, 0.25, 0.25));
    expect(result).toMatchObject({ mirrored: false, result: { match: 'similar', photo: { id: photo.id } } });
    if (result.result.match !== 'similar') return;
    expect(result.result.shape!.ofPhoto).toBeGreaterThan(0.2);
    expect(result.result.shape!.ofPhoto).toBeLessThan(0.3);
    expect(result.result.shape!.ofFile).toBeGreaterThan(0.95);
  });

  it('a corner crop, made small', async () => {
    const file = await sharp(await cut(original, 0, 0, 0.4, 0.35)).resize({ width: 600 }).jpeg({ quality: 75 }).toBuffer();
    expect(await check(file)).toMatchObject({ result: { match: 'similar', photo: { id: photo.id } } });
  });

  it('a mirror image', async () => {
    const result = await check(await sharp(original).flop().jpeg({ quality: 85 }).toBuffer());
    expect(result).toMatchObject({ mirrored: true, result: { match: 'similar', photo: { id: photo.id }, shape: { rotation: 0 } } });
  });

  it('a mirror image of a crop', async () => {
    const result = await check(await sharp(await cut(original, 0.15, 0.1, 0.2, 0.2)).flop().jpeg({ quality: 85 }).toBuffer());
    expect(result).toMatchObject({ mirrored: true, result: { match: 'similar', photo: { id: photo.id } } });
  });

  it.each([90, 180, 270])('a copy turned %i degrees', async (turn) => {
    const result = await check(await sharp(original).rotate(turn).jpeg({ quality: 85 }).toBuffer());
    expect(result).toMatchObject({ mirrored: false, result: { match: 'similar', photo: { id: photo.id } } });
    // The file was turned clockwise by `turn`, so the turn back onto the photo is the rest of the circle.
    if (result.result.match === 'similar') expect(result.result.shape!.rotation).toBe(360 - turn);
  });

  it('a copy tilted by 6 degrees', async () => {
    const result = await check(await sharp(original).rotate(6, { background: '#101010' }).jpeg({ quality: 85 }).toBuffer());
    expect(result).toMatchObject({ result: { match: 'similar', photo: { id: photo.id } } });
  });

  it('the photo inside a phone screenshot', async () => {
    const inner = await sharp(original).resize({ width: 1000 }).toBuffer();
    const file = await sharp({ create: { width: 1170, height: 2532, channels: 3, background: '#ffffff' } })
      .composite([
        { input: inner, left: 85, top: 600 },
        { input: { create: { width: 700, height: 30, channels: 3, background: '#222222' } }, left: 85, top: 420 },
        { input: { create: { width: 420, height: 30, channels: 3, background: '#888888' } }, left: 85, top: 1460 },
      ])
      .jpeg({ quality: 85 })
      .toBuffer();
    const result = await check(file);
    expect(result).toMatchObject({ result: { match: 'similar', photo: { id: photo.id } } });
    if (result.result.match !== 'similar') return;
    expect(result.result.shape!.ofFile).toBeLessThan(0.4);
    expect(result.result.shape!.ofPhoto).toBeGreaterThan(0.95);
  });

  it('a copy with a logo on it and stronger colours', async () => {
    const logo = await sharp({ create: { width: 480, height: 90, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const file = await sharp(original).modulate({ saturation: 1.5, brightness: 1.1 }).composite([{ input: logo, gravity: 'southeast' }]).jpeg({ quality: 80 }).toBuffer();
    expect(await check(file)).toMatchObject({ result: { match: 'similar', photo: { id: photo.id } } });
  });

  it('finds the right photo of several', async () => {
    expect(await check(await cut(otherOriginal, 0.2, 0.2, 0.1, 0.1))).toMatchObject({ result: { match: 'similar', photo: { id: other.id } } });
  });
});

describe('a file that is not a copy', () => {
  it('another picture gets no proof, with the quick steps and with the search keys', async () => {
    const result = await check(await busyScene(999, Date.now()));
    expect(result.result).toEqual({ match: 'none' });
    // Both key searches ran (the file and its mirror image).
    expect(result.sent.filter((s) => 'keys' in s.body)).toHaveLength(2);
  });

  it('a plain picture with no detail gets no proof', async () => {
    const flat = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#7a8c9e' } }).jpeg().toBuffer();
    const result = await check(flat);
    expect(result.result).toEqual({ match: 'none' });
    expect(result.sent.some((s) => 'keys' in s.body)).toBe(false);
  });
});

describe('what the lookup tells and takes', () => {
  it('a candidate names no photo: no ID, no link, no image address', async () => {
    const result = await check(await cut(original, 0.2, 0.2, 0.2, 0.2));
    const candidates = result.sent.filter((s) => s.answer.match === 'candidates');
    expect(candidates.length).toBeGreaterThan(0);
    for (const { answer } of candidates) {
      const text = JSON.stringify(answer);
      for (const id of [photo.id, other.id]) expect(text).not.toContain(id);
      expect(text).not.toContain('http');
      if (answer.match !== 'candidates') continue;
      for (const candidate of answer.candidates) {
        expect(Object.keys(candidate).sort().join()).toMatch(/^(height,orientation,token,width|height,spots,token,width)$/);
      }
    }
  });

  it('sends hashes only: no pixel values and no positions before a candidate exists', async () => {
    const result = await check(await cut(original, 0.2, 0.2, 0.2, 0.2));
    for (const { path, body } of result.sent) {
      if (path === '/v1/lookup') expect(Object.keys(body).sort().join()).toMatch(/^(phashes,sha256,v|keys,v)$/);
      else expect(Object.keys(body).sort()).toEqual(['bits', 'frame', 'token', 'transform']);
    }
  });

  async function candidateToken(): Promise<{ token: string; confirm: Sent }> {
    const result = await check(await cut(original, 0.2, 0.2, 0.2, 0.2));
    const confirm = result.sent.find((s) => s.path === '/v1/lookup/confirm' && s.answer.match === 'similar')!;
    return { token: confirm.body.token as string, confirm };
  }
  const confirm = async (body: object) => (await h.app.inject({ method: 'POST', url: '/v1/lookup/confirm', payload: body })).json() as LookupResult;

  it('a candidate token with the bits of another picture gets no proof', async () => {
    const { confirm: good } = await candidateToken();
    expect(await confirm(good.body)).toMatchObject({ match: 'similar' });
    const t = good.body.transform as { a: number; b: number; tx: number; ty: number };
    // The detail bits of another picture, under the transform and the frame of the good request.
    for (const seed of [777, 778, 779]) {
      const stranger = queryFrame(await grayOf(await sharp(await busyScene(seed, Date.now())).resize({ width: 960 }).extract({ left: 0, top: 0, width: 960, height: 720 }).jpeg().toBuffer()));
      const bits = queryBits(stranger, t, frameOf(photo.width, photo.height));
      expect(bits).not.toBeNull();
      expect(await confirm({ ...good.body, frame: { width: stranger.gray.width, height: stranger.gray.height }, bits })).toEqual({ match: 'none' });
    }
    for (const bits of ['0'.repeat(576), 'f'.repeat(576), 'a5'.repeat(288), '3c'.repeat(288)]) {
      expect(await confirm({ ...good.body, bits })).toEqual({ match: 'none' });
    }
    // The right bits under a wrong transform (the file shifted by a tenth of the photo).
    expect(await confirm({ ...good.body, transform: { ...t, tx: t.tx + 77 } })).toEqual({ match: 'none' });
  });

  it('a changed, expired or invented token gets no proof', async () => {
    const { token, confirm: good } = await candidateToken();
    const flipped = token.slice(0, -2) + (token.at(-2) === 'A' ? 'B' : 'A') + token.slice(-1);
    expect(flipped).not.toBe(token);
    expect(await confirm({ ...good.body, token: flipped })).toEqual({ match: 'none' });
    expect(await confirm({ ...good.body, token: 'not-a-token' })).toEqual({ match: 'none' });
    h.clock.offsetMs += 6 * 60_000;
    try {
      expect(await confirm(good.body)).toEqual({ match: 'none' });
    } finally {
      h.clock.offsetMs -= 6 * 60_000;
    }
  });

  it('refuses a malformed confirm and oversized or broken keys', async () => {
    const { confirm: good } = await candidateToken();
    const post = (url: string, payload: object) => h.app.inject({ method: 'POST', url, payload }).then((r) => r.statusCode);
    expect(await post('/v1/lookup/confirm', { ...good.body, bits: 'zz' })).toBe(400);
    expect(await post('/v1/lookup/confirm', { ...good.body, frame: { width: 5000, height: 10 } })).toBe(400);
    expect(await post('/v1/lookup/confirm', { ...good.body, transform: { a: 1e9, b: 0, tx: 0, ty: 0 } })).toBe(400);
    // A transform that shows no usable part of the photo is an answer, not an error.
    expect(await confirm({ ...good.body, transform: { a: 1, b: 0, tx: 90_000, ty: 0 } })).toEqual({ match: 'none' });
    expect(await post('/v1/lookup', { v: 2, keys: 'not base64!' })).toBe(400);
    expect(await post('/v1/lookup', { v: 2, keys: packKeys(new Int32Array(3)).slice(0, -3) })).toBe(400);
    expect(await post('/v1/lookup', { v: 2, keys: packKeys(new Int32Array(MAX_QUERY_KEYS + 1)) })).toBe(400);
    expect(await post('/v1/lookup', { v: 2, keys: packKeys(new Int32Array(MAX_QUERY_KEYS).map((_, i) => i * 7919)) })).toBe(200);
  });

  it('a deleted photo is found by no step, and an earlier token for it is dead', async () => {
    const { photo: gone, original: file, install } = await publish(21);
    const crop = await cut(file, 0.2, 0.2, 0.2, 0.2);
    const before = await check(crop);
    expect(before).toMatchObject({ result: { match: 'similar', photo: { id: gone.id } } });
    const token = before.sent.find((s) => s.path === '/v1/lookup/confirm' && s.answer.match === 'similar')!;
    expect((await h.app.inject({ method: 'DELETE', url: `/v1/me/photos/${gone.id}`, headers: install.auth })).statusCode).toBe(204);
    expect((await check(crop)).result).toEqual({ match: 'none' });
    expect((await check(await sharp(file).resize({ width: 800 }).jpeg().toBuffer())).result).toEqual({ match: 'none' });
    expect(await confirm(token.body)).toEqual({ match: 'none' });
    const { rows } = await h.ctx.db.query<{ feature_keys: number[] | null }>('SELECT feature_keys FROM photos WHERE id = $1', [gone.id]);
    expect(rows[0].feature_keys).toBeNull();
  });

  it('the first version of the website gets the exact match, and no "looks like" without the confirm step', async () => {
    const old = async (payload: object) => (await h.app.inject({ method: 'POST', url: '/v1/lookup', payload })).json() as LookupResult;
    expect(await old({ sha256: sha256Hex(original) })).toMatchObject({ match: 'exact', photo: { id: photo.id } });
    const reposted = await sharp(original).resize({ width: 1080 }).jpeg({ quality: 70 }).toBuffer();
    const { data } = await sharp(reposted).resize(32, 32, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(await old({ sha256: sha256Hex(reposted), phash: phashFromLuma(lumaGrid(data, 3)) })).toEqual({ match: 'none' });
  });

  it('a very small copy is found by the quick steps', async () => {
    const result = await check(await sharp(original).resize({ width: 100 }).jpeg({ quality: 80 }).toBuffer());
    expect(result).toMatchObject({ result: { match: 'similar', photo: { id: photo.id } } });
    expect(result.sent.some((s) => 'keys' in s.body)).toBe(false);
  });

  it('a thin strip gets no proof: with one guessed bit for each column, and with the right bits', async () => {
    // Before the cells were squares, the rows of a thin strip were copies of one row, so one guessed bit for
    // each column was enough. Now a strip of 80 pixels has 5 rows of separate cells: fewer than the decision needs.
    const { confirm: good } = await candidateToken();
    const strip = { width: 768, height: 80 };
    const place = (i: number) => ({ a: 1, b: 0, tx: 0, ty: 60 + i * 9 });
    const stored = await frameGray((await h.ctx.storage.get(photoKeys.preview(photo.id)))!, photo.width, photo.height);
    const cells: number[] = [];
    let passed = 0;
    for (let i = 0; i < 40; i++) {
      const columns = Array.from({ length: 48 }, () => (Math.random() < 0.5 ? 1 : 0));
      let bits = '';
      for (let cell = 0; cell < 48 * 48; cell += 4) bits += ((columns[cell % 48] << 3) | (columns[(cell + 1) % 48] << 2) | (columns[(cell + 2) % 48] << 1) | columns[(cell + 3) % 48]).toString(16);
      cells.push(judgeBits(stored, bits, place(i), strip).cells);
      // Each try from its own address: the route permits 60 calls a minute from one address.
      const res = await h.app.inject({ method: 'POST', url: '/v1/lookup/confirm', payload: { token: good.body.token, frame: strip, transform: place(i), bits }, remoteAddress: `10.77.0.${i + 1}` });
      expect(res.statusCode).toBe(200);
      if ((res.json() as LookupResult).match !== 'none') passed++;
    }
    expect(passed).toBe(0);
    // The strip does give bits to compare (so the guesses were judged), but never enough for a decision.
    expect(Math.max(...cells)).toBeGreaterThan(40);
    expect(Math.max(...cells)).toBeLessThan(MIN_DETAIL_CELLS);
    // The right bits of a true strip of the photo: still no proof, and the answer says why.
    const trueStrip = queryFrame({ width: stored.width, height: 80, data: stored.data.slice(150 * stored.width, 230 * stored.width) });
    const rightBits = queryBits(trueStrip, { a: 1, b: 0, tx: 0, ty: 150 }, stored)!;
    expect(await confirm({ token: good.body.token, frame: strip, transform: { a: 1, b: 0, tx: 0, ty: 150 }, bits: rightBits })).toEqual({ match: 'none', unclear: true });
  });

  it('a photo with little detail: the answer is "could not compare", not "no proof"', async () => {
    // A stored photo that is plain but for one small corner (as a wall with a light switch).
    const { photo: plain } = await publish(31);
    const corner = await sharp(await busyScene(32, Date.now())).extract({ left: 0, top: 0, width: 220, height: 220 }).toBuffer();
    const file = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#8a8f94' } }).composite([{ input: corner, left: 1100, top: 700 }]).jpeg({ quality: 90 }).toBuffer();
    const images = await makePublicImages(file);
    await h.ctx.storage.put(photoKeys.preview(plain.id), images.preview, 'image/jpeg');
    await h.ctx.db.query('UPDATE photos SET phash = $2, feature_keys = $3::int4[], feature_x = $4::int2[], feature_y = $5::int2[] WHERE id = $1', [plain.id, images.phash, ...featureColumns(images.code)]);
    const result = await check(await sharp(file).resize({ width: 900 }).jpeg({ quality: 80 }).toBuffer());
    expect(result.result).toEqual({ match: 'none', unclear: true });
  });

  it('answers "busy", never "no proof", when the key search fails', async () => {
    const transaction = h.ctx.db.transaction;
    h.ctx.db.transaction = async () => {
      throw new Error('canceling statement due to statement timeout');
    };
    try {
      const res = await h.app.inject({ method: 'POST', url: '/v1/lookup', payload: { v: 2, keys: packKeys(Int32Array.from([1, 2, 3])) } });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: { code: 'busy' } });
    } finally {
      h.ctx.db.transaction = transaction;
    }
  });
});
