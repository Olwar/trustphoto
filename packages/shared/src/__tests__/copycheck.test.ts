import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  alignToCandidate,
  checkFile,
  judgeBits,
  MIN_AGREEMENT,
  packKeys,
  queryBits,
  queryCode,
  sharedSpots,
  storedCode,
  unpackKeys,
  wholeFrameBits,
} from '../copycheck';
import { extractFeatures, featureKeys, fitInside, mirrorGray, prepareGray, resizeGray, type Gray } from '../features';
import { fitSimilarity, rotationOf, sharedGrid, wholeFrameTransform, type PointPair } from '../match';
import { hammingDistance, lumaGrid, ORIENTATIONS, orientedPhashes, PHASH_SIZE, phashFromLuma, SIMILAR_MAX_DISTANCE } from '../phash';

/** A drawn picture: soft-edged boxes and discs of many sizes on a gradient, with a little grain. */
function scene(seed: number, width = 1024, height = 768): Gray {
  let s = (seed * 2654435761) >>> 0 || 1;
  const r = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return ((s >>> 8) & 0xffff) / 0x10000;
  };
  const px = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) px[y * width + x] = 90 + 50 * (y / height) + 20 * (x / width);
  for (let i = 0; i < 160; i++) {
    const cx = r() * width;
    const cy = r() * height;
    const w = 15 + r() * 90;
    const h = 15 + r() * 90;
    const level = 20 + r() * 215;
    const disc = r() < 0.4;
    const turn = r() * Math.PI;
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    const reach = Math.ceil(Math.hypot(w, h));
    for (let y = Math.max(0, Math.floor(cy - reach)); y < Math.min(height, cy + reach); y++) {
      for (let x = Math.max(0, Math.floor(cx - reach)); x < Math.min(width, cx + reach); x++) {
        const u = (x - cx) * cos + (y - cy) * sin;
        const v = -(x - cx) * sin + (y - cy) * cos;
        const inside = disc ? (u * u) / (w * w) + (v * v) / (h * h) <= 1 : Math.abs(u) <= w && Math.abs(v) <= h;
        if (inside) px[y * width + x] = level;
      }
    }
  }
  const data = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      // A 3x3 mean softens the edges, as a lens does; then grain.
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += px[(y + dy) * width + x + dx];
      data[y * width + x] = Math.max(0, Math.min(255, Math.round(sum / 9 + (r() - 0.5) * 6)));
    }
  }
  return { width, height, data };
}

function crop(gray: Gray, left: number, top: number, width: number, height: number): Gray {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) data.set(gray.data.subarray((top + y) * gray.width + left, (top + y) * gray.width + left + width), y * width);
  return { width, height, data };
}

/** The picture turned a quarter turn clockwise. */
function turnClockwise(gray: Gray): Gray {
  const { width, height } = gray;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[x * height + (height - 1 - y)] = gray.data[y * width + x];
  return { width: height, height: width, data };
}

function lumaOf(gray: Gray): Float64Array {
  const small = resizeGray(gray, PHASH_SIZE, PHASH_SIZE);
  const rgb = new Uint8Array(PHASH_SIZE * PHASH_SIZE * 3);
  small.data.forEach((v, i) => rgb.fill(v, i * 3, i * 3 + 3));
  return lumaGrid(rgb, 3);
}

/** The steps of copycheck.ts with no network between them. */
function check(file: Gray, photo: Gray) {
  const stored = storedCode(prepareGray(photo));
  const query = queryCode(file);
  const aligned = alignToCandidate(query, sharedSpots(stored, new Set(query.keys)));
  if (!aligned) return null;
  const bits = queryBits(query, aligned.transform, stored);
  return bits ? judgeBits(prepareGray(photo), bits, aligned.transform, query.gray) : null;
}

const photo = scene(1);

describe('features', () => {
  it('are the same in every build: stored keys must stay valid', () => {
    // A change of the detector, the test pattern or the key hash changes this digest. Stored photos then
    // need new keys: node apps/server/dist/backfill-features.js --all (see README).
    const keys = featureKeys(extractFeatures(prepareGray(photo)));
    expect(keys.length).toBeGreaterThan(2000);
    expect(createHash('sha256').update(Buffer.from(keys.buffer)).digest('hex').slice(0, 16)).toMatchInlineSnapshot(`"0c26f0ba2d4609a5"`);
  });

  it('finds no feature in a plain picture', () => {
    expect(extractFeatures({ width: 400, height: 300, data: new Uint8Array(120_000).fill(128) }).count).toBe(0);
    expect(queryCode({ width: 400, height: 300, data: new Uint8Array(120_000).fill(128) }).keys).toHaveLength(0);
  });

  it('takes a small file at each different size once', () => {
    // At 300 pixels the two smaller sizes are the same picture: one set of keys, not two.
    const small = queryCode(scene(7, 300, 200));
    expect(small.keys.length).toBeGreaterThan(0);
    expect(small.keys.length).toBeLessThanOrEqual(500 * 8);
  });

  it('handles a picture too small for any feature', () => {
    expect(extractFeatures({ width: 20, height: 12, data: new Uint8Array(240) }).count).toBe(0);
  });

  it('packs keys for the wire and back', () => {
    const keys = Int32Array.from([0, 1, -1, 2147483647, -2147483648, 123456789]);
    expect(unpackKeys(packKeys(keys))).toEqual(keys);
    expect(unpackKeys(packKeys(new Int32Array(0)))).toEqual(new Int32Array(0));
    expect(unpackKeys('AAAAAAA=')).toBeNull(); // 5 bytes: not whole numbers
    expect(unpackKeys('%%%%')).toBeNull();
  });
});

describe('the geometry', () => {
  it('recovers a known shift, turn and zoom from pairs with wrong pairs mixed in', () => {
    const t = { a: 1.3 * Math.cos(0.2), b: 1.3 * Math.sin(0.2), tx: 40, ty: -25 };
    const pairs: PointPair[] = [];
    for (let i = 0; i < 40; i++) {
      const qx = (i * 37) % 500;
      const qy = (i * 91) % 400;
      pairs.push({ qx, qy, cx: t.a * qx - t.b * qy + t.tx, cy: t.b * qx + t.a * qy + t.ty });
    }
    for (let i = 0; i < 80; i++) pairs.push({ qx: (i * 53) % 500, qy: (i * 29) % 400, cx: (i * 71) % 700, cy: (i * 13) % 600 });
    const fitted = fitSimilarity(pairs)!;
    expect(fitted.inliers).toBeGreaterThanOrEqual(40);
    expect(fitted.transform.a).toBeCloseTo(t.a, 3);
    expect(fitted.transform.b).toBeCloseTo(t.b, 3);
    expect(fitted.transform.tx).toBeCloseTo(t.tx, 1);
    expect(rotationOf(fitted.transform)).toBe(11);
  });

  it('counts a spot once when several of its keys pair it', () => {
    const one = { qx: 10, qy: 10, cx: 20, cy: 20 };
    const two = { qx: 200, qy: 50, cx: 210, cy: 60 };
    expect(fitSimilarity([one, one, one, one, two, two, two, two])).toBeNull();
  });

  it('keeps the transform that more spots agree on, when two spots have many pairs', () => {
    const pairs: PointPair[] = [];
    for (let i = 0; i < 16; i++) pairs.push({ qx: 20 + i * 31, qy: 15 + ((i * 53) % 300), cx: 120 + i * 31, cy: 65 + ((i * 53) % 300) });
    for (let i = 0; i < 30; i++) pairs.push({ qx: 10, qy: 10, cx: 400, cy: 20 }, { qx: 300, qy: 40, cx: 90, cy: 500 });
    expect(fitSimilarity(pairs)?.inliers).toBe(16);
  });

  it('counts a thin strip as few cells: each cell is a separate square', () => {
    const strip = sharedGrid({ a: 1, b: 0, tx: 0, ty: 200 }, { width: 768, height: 48 }, { width: 768, height: 576 })!;
    expect(strip.inside.reduce((n, v) => n + v, 0)).toBeLessThan(150);
    // No two cells overlap: the centres are a full cell apart on both axes.
    expect(strip.candidateY[48] - strip.candidateY[0]).toBeCloseTo(2 * strip.halfCandidate, 6);
    expect(strip.candidateX[1] - strip.candidateX[0]).toBeCloseTo(2 * strip.halfCandidate, 6);
  });

  it('says what part of each picture the two share', () => {
    // The file is the middle half of the photo, at the same scale.
    const grid = sharedGrid({ a: 1, b: 0, tx: 192, ty: 144 }, { width: 384, height: 288 }, { width: 768, height: 576 })!;
    expect(grid.ofCandidate).toBeCloseTo(0.25, 5);
    expect(grid.ofQuery).toBeCloseTo(1, 5);
    // The photo is the middle of a larger file.
    const inside = sharedGrid({ a: 1, b: 0, tx: -192, ty: -144 }, { width: 768, height: 576 }, { width: 384, height: 288 })!;
    expect(inside.ofCandidate).toBeCloseTo(1, 5);
    expect(inside.ofQuery).toBeCloseTo(0.25, 5);
    expect(sharedGrid({ a: 1, b: 0, tx: 5000, ty: 0 }, { width: 768, height: 576 }, { width: 768, height: 576 })).toBeNull();
    expect(sharedGrid({ a: NaN, b: 0, tx: 0, ty: 0 }, { width: 768, height: 576 }, { width: 768, height: 576 })).toBeNull();
    expect(sharedGrid({ a: 0.01, b: 0, tx: 0, ty: 0 }, { width: 768, height: 576 }, { width: 768, height: 576 })).toBeNull();
    // A copy 8 times smaller than the photo is a usable match; a cell under one pixel is not.
    expect(sharedGrid({ a: 8, b: 0, tx: 0, ty: 0 }, { width: 96, height: 72 }, { width: 768, height: 576 })).not.toBeNull();
    expect(sharedGrid({ a: 19, b: 0, tx: 0, ty: 0 }, { width: 40, height: 30 }, { width: 768, height: 576 })).toBeNull();
  });

  it('puts the whole file onto the whole photo for each quarter turn', () => {
    const file = { width: 300, height: 400 };
    const stored = { width: 400, height: 300 };
    const t = wholeFrameTransform(file, stored, 90);
    // Clockwise: the top left corner of the file goes to the top right corner of the photo.
    expect([t.a * 0 - t.b * 0 + t.tx, t.b * 0 + t.a * 0 + t.ty]).toEqual([400, 0]);
    expect(rotationOf(t)).toBe(90);
    expect(rotationOf(wholeFrameTransform(file, file, 180))).toBe(180);
    expect(rotationOf(wholeFrameTransform(file, stored, 270))).toBe(270);
  });
});

describe('a copy against its photo', () => {
  it('a smaller copy agrees on nearly every bit', () => {
    const size = fitInside(photo.width, photo.height, 500);
    const judged = check(resizeGray(photo, size.width, size.height), photo)!;
    expect(judged.match).toBe(true);
    expect(judged.agreement).toBeGreaterThan(0.9);
    expect(judged.shape!.ofPhoto).toBeGreaterThan(0.97);
  });

  it('a crop is found, and the answer says how much of the photo it shows', () => {
    const judged = check(crop(photo, 300, 200, 500, 380), photo)!;
    expect(judged.match).toBe(true);
    expect(judged.shape!.ofPhoto).toBeCloseTo((500 * 380) / (1024 * 768), 1);
    expect(judged.shape!.ofFile).toBeGreaterThan(0.95);
    expect(judged.shape!.rotation).toBe(0);
  });

  it('a turned crop is found', () => {
    const judged = check(turnClockwise(crop(photo, 100, 100, 700, 500)), photo)!;
    expect(judged.match).toBe(true);
    expect(judged.shape!.rotation).toBe(270);
  });

  it('a mirror image is found only when the file is mirrored back', () => {
    const mirrored = mirrorGray(crop(photo, 150, 100, 700, 560));
    expect(check(mirrored, photo)?.match ?? false).toBe(false);
    expect(check(mirrorGray(mirrored), photo)!.match).toBe(true);
  });

  it('a full copy needs no features: the bits of the whole frame agree', () => {
    const stored = prepareGray(photo);
    const size = fitInside(photo.width, photo.height, 640);
    const file = queryCode(resizeGray(photo, size.width, size.height));
    const whole = wholeFrameBits(file, stored, 0)!;
    expect(judgeBits(stored, whole.bits, whole.transform, file.gray).match).toBe(true);
    // The same file under a wrong turn does not agree.
    const upsideDown = wholeFrameBits(file, stored, 180)!;
    expect(judgeBits(stored, upsideDown.bits, upsideDown.transform, file.gray).agreement).toBeLessThan(0.65);
  });

  it('another picture does not agree, with the same transform or with its own', () => {
    const stored = prepareGray(photo);
    for (const seed of [2, 3, 4, 5]) {
      const file = queryCode(scene(seed));
      const whole = wholeFrameBits(file, stored, 0)!;
      const judged = judgeBits(stored, whole.bits, whole.transform, file.gray);
      expect(judged.match).toBe(false);
      expect(judged.agreement).toBeLessThan(MIN_AGREEMENT - 0.15);
      expect(check(scene(seed), photo)?.match ?? false).toBe(false);
    }
  });

  it('a picture with no clear detail cannot be confirmed', () => {
    const flat = { width: 768, height: 576, data: new Uint8Array(768 * 576).fill(120) };
    const file = queryCode(flat);
    const whole = wholeFrameBits(file, flat, 0)!;
    expect(judgeBits(flat, whole.bits, whole.transform, file.gray)).toMatchObject({ match: false, cells: 0 });
  });
});

describe('the pHash of a turned or mirrored copy', () => {
  it('has the photo pHash in the matching orientation, and only there', () => {
    const own = phashFromLuma(lumaOf(photo));
    expect(orientedPhashes(lumaOf(photo))[0]).toBe(own);
    // The file is the photo turned a quarter turn against the clock: one clockwise turn of the file gives the photo.
    const againstClock = turnClockwise(turnClockwise(turnClockwise(photo)));
    const cases: Array<[Gray, number]> = [
      [againstClock, 1],
      [turnClockwise(turnClockwise(photo)), 2],
      [turnClockwise(photo), 3],
      [mirrorGray(photo), 4],
    ];
    for (const [file, index] of cases) {
      const hashes = orientedPhashes(lumaOf(file));
      const near = hashes.map((hash, i) => (hammingDistance(hash, own) <= SIMILAR_MAX_DISTANCE ? i : -1)).filter((i) => i >= 0);
      expect(near).toEqual([index]);
    }
    expect(ORIENTATIONS[1]).toEqual({ mirrored: false, rotation: 90 });
  });
});

describe('the whole flow', () => {
  it('says "unclear" when a candidate had too little detail for the server to decide', async () => {
    const calls: string[] = [];
    const outcome = await checkFile({ sha256: 'a'.repeat(64), luma: lumaOf(photo), full: () => photo }, async (path) => {
      calls.push(path);
      if (path === '/v1/lookup/confirm') return { match: 'none', unclear: true };
      return calls.length === 1 ? { match: 'candidates', candidates: [{ token: 't', width: 768, height: 576, orientation: 0 }] } : { match: 'none' };
    });
    expect(outcome).toEqual({ result: { match: 'none', unclear: true }, mirrored: false });
    expect(calls.slice(0, 2)).toEqual(['/v1/lookup', '/v1/lookup/confirm']);
  });
});
