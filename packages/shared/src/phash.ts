/**
 * Perceptual hash (pHash), so a copy of a verified photo can be found after a
 * social network resized or re-compressed it. The exact SHA-256 finds only
 * the untouched file.
 *
 * Same algorithm as Python imagehash.phash: 32x32 grayscale, 2D DCT-II,
 * the 8x8 lowest frequencies, one bit per coefficient above their median.
 * The server and the browser both call this, so the two sides must feed it
 * the same 32x32 luma grid (Rec. 601 weights, as PIL's convert('L')).
 */

export const PHASH_SIZE = 32;
const LOW = 8;
/** Hamming distance (of 64 bits) at or under which two photos count as the same picture. */
export const SIMILAR_MAX_DISTANCE = 10;

const COS: number[][] = Array.from({ length: LOW }, (_, u) =>
  Array.from({ length: PHASH_SIZE }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / (2 * PHASH_SIZE))),
);

/** Rec. 601 luma of a PHASH_SIZE x PHASH_SIZE RGB or RGBA pixel buffer. */
export function lumaGrid(pixels: ArrayLike<number>, channels: 3 | 4): Float64Array {
  const n = PHASH_SIZE * PHASH_SIZE;
  if (pixels.length < n * channels) throw new Error(`expected ${n * channels} values, got ${pixels.length}`);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    out[i] = 0.299 * pixels[o] + 0.587 * pixels[o + 1] + 0.114 * pixels[o + 2];
  }
  return out;
}

/** 64-bit pHash as 16 lowercase hex characters. */
export function phashFromLuma(luma: ArrayLike<number>): string {
  const n = PHASH_SIZE;
  if (luma.length !== n * n) throw new Error(`expected ${n * n} luma values, got ${luma.length}`);

  // Rows first: rowDct[y][u] = sum_x luma[y][x] * cos(u, x)
  const rowDct: number[][] = [];
  for (let y = 0; y < n; y++) {
    const row = new Array<number>(LOW).fill(0);
    for (let u = 0; u < LOW; u++) {
      let sum = 0;
      for (let x = 0; x < n; x++) sum += luma[y * n + x] * COS[u][x];
      row[u] = sum;
    }
    rowDct.push(row);
  }
  // Then columns, for the 8x8 low-frequency block only.
  const coeffs: number[] = [];
  for (let v = 0; v < LOW; v++) {
    for (let u = 0; u < LOW; u++) {
      let sum = 0;
      for (let y = 0; y < n; y++) sum += rowDct[y][u] * COS[v][y];
      coeffs.push(sum);
    }
  }

  const sorted = [...coeffs].sort((a, b) => a - b);
  const median = (sorted[31] + sorted[32]) / 2;

  let hex = '';
  for (let nibble = 0; nibble < 16; nibble++) {
    let value = 0;
    for (let bit = 0; bit < 4; bit++) {
      value = (value << 1) | (coeffs[nibble * 4 + bit] > median ? 1 : 0);
    }
    hex += value.toString(16);
  }
  return hex;
}

/** Number of differing bits between two 16-hex-character hashes. */
export function hammingDistance(a: string, b: string): number {
  if (!isPhash(a) || !isPhash(b)) throw new Error('invalid pHash');
  let diff = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (diff > 0n) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}

export function isPhash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);
}

/** The eight ways a full copy can be turned or mirrored. `mirrored` first (left and right exchanged), then `rotation` degrees clockwise. */
export const ORIENTATIONS: ReadonlyArray<{ mirrored: boolean; rotation: 0 | 90 | 180 | 270 }> = [
  { mirrored: false, rotation: 0 },
  { mirrored: false, rotation: 90 },
  { mirrored: false, rotation: 180 },
  { mirrored: false, rotation: 270 },
  { mirrored: true, rotation: 0 },
  { mirrored: true, rotation: 90 },
  { mirrored: true, rotation: 180 },
  { mirrored: true, rotation: 270 },
];

/**
 * The pHash of the picture in each of ORIENTATIONS, from its 32x32 luma grid.
 * A mirrored or turned copy has the stored photo's pHash in one of them.
 */
export function orientedPhashes(luma: ArrayLike<number>): string[] {
  const n = PHASH_SIZE;
  if (luma.length !== n * n) throw new Error(`expected ${n * n} luma values, got ${luma.length}`);
  return ORIENTATIONS.map(({ mirrored, rotation }) => {
    const out = new Float64Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const mx = mirrored ? n - 1 - x : x;
        // A point (mx, y) of the picture goes here after the clockwise turn.
        const [tx, ty] = rotation === 0 ? [mx, y] : rotation === 90 ? [n - 1 - y, mx] : rotation === 180 ? [n - 1 - mx, n - 1 - y] : [y, n - 1 - mx];
        out[ty * n + tx] = luma[y * n + x];
      }
    }
    return phashFromLuma(out);
  });
}
