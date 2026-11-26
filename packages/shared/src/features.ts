/**
 * Local picture features, so "Check a photo" can find a cropped, mirrored,
 * rotated or screenshotted copy that the whole-picture pHash misses.
 *
 * The method is ORB (Rublee et al., 2011): FAST-9 corners on a scale pyramid,
 * ranked by the Harris measure, each with an orientation from its intensity
 * centroid and a 256-bit steered BRIEF descriptor. The server and the browser
 * both run this file on a grey picture of the same size, so the two sides give
 * near-equal features for the same picture.
 */

import { mulberry32 } from './random';

/** Long side of the grey picture the features are made from. */
export const FEATURE_SIZE = 768;
/** A decoder may hand over a picture up to this long side; `prepareGray` makes the last resize itself. */
export const FEATURE_INPUT_MAX = FEATURE_SIZE * 2;
/** 32-bit words in one descriptor (256 bits). */
export const DESCRIPTOR_WORDS = 8;

const LEVELS = 8;
const LEVEL_SCALE = 1.2;
const PATCH = 31;
const HALF_PATCH = 15;
/** No feature closer than this to a level's border: the patch, the rotated tests and the blur stay inside. */
const EDGE = 19;
const FAST_THRESHOLD = 20;
const FAST_THRESHOLD_LOW = 8;
const HARRIS_K = 0.04;
const CELL = 32;
/** Lowest `patchStructure` of a feature. */
const MIN_STRUCTURE = 0.2;

export interface Gray {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface Features {
  /** Size of the grey picture the coordinates refer to. */
  width: number;
  height: number;
  count: number;
  x: Float32Array;
  y: Float32Array;
  /** Patch diameter in pixels of the grey picture. */
  size: Float32Array;
  /** Radians. */
  angle: Float32Array;
  /** DESCRIPTOR_WORDS words for each feature. */
  descriptors: Uint32Array;
}

/** Rec. 601 luma of an RGB or RGBA pixel buffer. */
export function grayFromPixels(pixels: ArrayLike<number>, width: number, height: number, channels: 3 | 4): Gray {
  const n = width * height;
  if (pixels.length < n * channels) throw new Error(`expected ${n * channels} values, got ${pixels.length}`);
  const data = new Uint8Array(n);
  for (let i = 0, o = 0; i < n; i++, o += channels) {
    data[i] = (0.299 * pixels[o] + 0.587 * pixels[o + 1] + 0.114 * pixels[o + 2] + 0.5) | 0;
  }
  return { width, height, data };
}

/** For each output sample: the first input sample and the weights of the inputs it averages. */
function areaWeights(from: number, to: number): { start: Int32Array; span: number; weights: Float32Array } {
  const scale = from / to;
  const span = Math.ceil(scale) + 1;
  const start = new Int32Array(to);
  const weights = new Float32Array(to * span);
  for (let i = 0; i < to; i++) {
    const a = i * scale;
    const b = Math.min(from, (i + 1) * scale);
    const first = Math.floor(a);
    start[i] = first;
    for (let k = 0; k < span; k++) {
      const lo = Math.max(a, first + k);
      const hi = Math.min(b, first + k + 1);
      weights[i * span + k] = hi > lo ? (hi - lo) / (b - a) : 0;
    }
  }
  return { start, span, weights };
}

/** Area-average resize to a smaller or equal size. */
export function resizeGray(src: Gray, width: number, height: number): Gray {
  if (width > src.width || height > src.height) throw new Error('resizeGray makes a picture smaller only');
  if (width === src.width && height === src.height) return src;
  const wx = areaWeights(src.width, width);
  const wy = areaWeights(src.height, height);
  const rows = new Float32Array(src.height * width);
  for (let y = 0; y < src.height; y++) {
    const row = y * src.width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      const first = wx.start[x];
      for (let k = 0; k < wx.span; k++) {
        const w = wx.weights[x * wx.span + k];
        if (w !== 0) sum += w * src.data[row + first + k];
      }
      rows[y * width + x] = sum;
    }
  }
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const first = wy.start[y];
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = 0; k < wy.span; k++) {
        const w = wy.weights[y * wy.span + k];
        if (w !== 0) sum += w * rows[(first + k) * width + x];
      }
      data[y * width + x] = (sum + 0.5) | 0;
    }
  }
  return { width, height, data };
}

/** The size of a picture when its long side is brought down to `long` (never up). */
export function fitInside(width: number, height: number, long: number): { width: number; height: number } {
  const own = Math.max(width, height);
  if (own <= long) return { width, height };
  const k = long / own;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** The grey picture at the size the features use: long side FEATURE_SIZE, or the picture's own size when it is smaller. */
export function prepareGray(gray: Gray): Gray {
  const size = fitInside(gray.width, gray.height, FEATURE_SIZE);
  return resizeGray(gray, size.width, size.height);
}

/** The picture as a mirror shows it (left and right exchanged). */
export function mirrorGray(gray: Gray): Gray {
  const { width, height } = gray;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) data[row + x] = gray.data[row + width - 1 - x];
  }
  return { width, height, data };
}

const BLUR = (() => {
  const sigma = 2;
  const taps = [-3, -2, -1, 0, 1, 2, 3].map((d) => Math.exp(-(d * d) / (2 * sigma * sigma)));
  const sum = taps.reduce((a, b) => a + b, 0);
  return taps.map((t) => t / sum);
})();

/** 7x7 Gaussian blur (sigma 2), borders clamped. */
function blur(src: Gray): Uint8Array {
  const { width, height, data } = src;
  const mid = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -3; k <= 3; k++) {
        const xx = x + k < 0 ? 0 : x + k >= width ? width - 1 : x + k;
        sum += BLUR[k + 3] * data[row + xx];
      }
      mid[row + x] = sum;
    }
  }
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -3; k <= 3; k++) {
        const yy = y + k < 0 ? 0 : y + k >= height ? height - 1 : y + k;
        sum += BLUR[k + 3] * mid[yy * width + x];
      }
      out[y * width + x] = (sum + 0.5) | 0;
    }
  }
  return out;
}

/** 256 point pairs within 13 pixels of the centre, drawn from a Gaussian (BRIEF, "G II"). x1, y1, x2, y2 for each pair. */
const PATTERN = (() => {
  const random = mulberry32(0x74727573); // "trus"
  const gauss = (): number => {
    const u = Math.max(random(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
  };
  const sigma = PATCH / 5;
  const point = (): [number, number] => {
    for (;;) {
      const x = gauss() * sigma;
      const y = gauss() * sigma;
      // Whole pixels, as in ORB: every JavaScript engine then makes the same pattern.
      if (x * x + y * y <= 13 * 13) return [Math.round(x), Math.round(y)];
    }
  };
  const out = new Float32Array(DESCRIPTOR_WORDS * 32 * 4);
  for (let i = 0; i < DESCRIPTOR_WORDS * 32; i++) {
    let a = point();
    let b = point();
    while (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < 2) {
      a = point();
      b = point();
    }
    out.set([a[0], a[1], b[0], b[1]], i * 4);
  }
  return out;
})();

/** The 16 pixels of the FAST circle (radius 3), clockwise from the top. */
const CIRCLE: ReadonlyArray<readonly [number, number]> = [
  [0, -3], [1, -3], [2, -2], [3, -1], [3, 0], [3, 1], [2, 2], [1, 3],
  [0, 3], [-1, 3], [-2, 2], [-3, 1], [-3, 0], [-3, -1], [-2, -2], [-1, -3],
];

/** Half-width of the circular patch at each row, for the orientation. */
const U_MAX = Array.from({ length: HALF_PATCH + 1 }, (_, v) => Math.floor(Math.sqrt(HALF_PATCH * HALF_PATCH - v * v)));

/** True when a 16-bit ring has 9 or more set bits in a row (the ring wraps). */
function hasArc(ring: number): boolean {
  let m = (ring | (ring << 16)) >>> 0;
  for (let i = 0; i < 8; i++) m &= m >>> 1;
  return m !== 0;
}

/** FAST-9 corners of one level, as pixel indexes. */
function fastCorners(level: Gray, threshold: number): number[] {
  const { width, height, data } = level;
  const offsets = CIRCLE.map(([dx, dy]) => dy * width + dx);
  const found: number[] = [];
  for (let y = EDGE; y < height - EDGE; y++) {
    for (let x = EDGE, i = y * width + EDGE; x < width - EDGE; x++, i++) {
      const hi = data[i] + threshold;
      const lo = data[i] - threshold;
      // An arc of 9 holds one of each opposite pair, so two "same" opposites rule a corner out.
      const top = data[i + offsets[0]];
      const bottom = data[i + offsets[8]];
      if (top <= hi && top >= lo && bottom <= hi && bottom >= lo) continue;
      const right = data[i + offsets[4]];
      const left = data[i + offsets[12]];
      if (right <= hi && right >= lo && left <= hi && left >= lo) continue;
      let bright = 0;
      let dark = 0;
      for (let k = 0; k < 16; k++) {
        const v = data[i + offsets[k]];
        if (v > hi) bright |= 1 << k;
        else if (v < lo) dark |= 1 << k;
      }
      if (hasArc(bright) || hasArc(dark)) found.push(i);
    }
  }
  return found;
}

/** Harris corner measure over a 7x7 block of Sobel gradients. */
function harris(level: Gray, index: number): number {
  const { width, data } = level;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const i = index + dy * width + dx;
      const gx = data[i - width + 1] + 2 * data[i + 1] + data[i + width + 1] - data[i - width - 1] - 2 * data[i - 1] - data[i + width - 1];
      const gy = data[i + width - 1] + 2 * data[i + width] + data[i + width + 1] - data[i - width - 1] - 2 * data[i - width] - data[i - width + 1];
      xx += gx * gx;
      yy += gy * gy;
      xy += gx * gy;
    }
  }
  const trace = xx + yy;
  return xx * yy - xy * xy - HARRIS_K * trace * trace;
}

/**
 * How two-directional the brightness changes in the whole patch are, 0 to 1
 * (the ratio of the two eigenvalues of the structure tensor). A patch with one
 * straight edge gives near 0. Such patches look the same in every picture, so
 * they cannot tell one picture from another one.
 */
function patchStructure(level: Gray, index: number): number {
  const { width, data } = level;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let v = -HALF_PATCH + 1; v < HALF_PATCH; v++) {
    const reach = U_MAX[Math.abs(v)] - 1;
    for (let u = -reach; u <= reach; u++) {
      const i = index + v * width + u;
      const gx = data[i + 1] - data[i - 1];
      const gy = data[i + width] - data[i - width];
      xx += gx * gx;
      yy += gy * gy;
      xy += gx * gy;
    }
  }
  const root = Math.sqrt((xx - yy) * (xx - yy) + 4 * xy * xy);
  const major = xx + yy + root;
  return major <= 0 ? 0 : (xx + yy - root) / major;
}

/** The strongest corners of a level, spread over the picture: the best of each cell first, then the second best, and so on. */
function selectCorners(level: Gray, wanted: number): number[] {
  let corners = fastCorners(level, FAST_THRESHOLD);
  if (corners.length < wanted * 2) corners = fastCorners(level, FAST_THRESHOLD_LOW);
  const { width, height } = level;
  const response = new Float32Array(width * height);
  for (const i of corners) response[i] = harris(level, i);
  const cols = Math.ceil(width / CELL);
  const cells = new Map<number, number[]>();
  for (const i of corners) {
    const r = response[i];
    if (r <= 0) continue;
    // Keep a corner only when no neighbour is stronger.
    if (
      response[i - 1] > r || response[i + 1] > r || response[i - width] > r || response[i + width] > r ||
      response[i - width - 1] > r || response[i - width + 1] > r || response[i + width - 1] > r || response[i + width + 1] > r
    ) continue;
    if (patchStructure(level, i) < MIN_STRUCTURE) continue;
    const cell = Math.floor(Math.floor(i / width) / CELL) * cols + Math.floor((i % width) / CELL);
    const list = cells.get(cell);
    if (list) list.push(i);
    else cells.set(cell, [i]);
  }
  const strongestFirst = (a: number, b: number): number => response[b] - response[a] || a - b;
  const lists = [...cells.values()];
  for (const list of lists) list.sort(strongestFirst);
  const picked: number[] = [];
  for (let rank = 0; picked.length < wanted; rank++) {
    const round = lists.filter((list) => list.length > rank).map((list) => list[rank]).sort(strongestFirst);
    if (round.length === 0) break;
    for (const i of round) {
      if (picked.length >= wanted) break;
      picked.push(i);
    }
  }
  return picked;
}

/** Features of a grey picture (use `prepareGray` first). At most `max` of them. */
export function extractFeatures(base: Gray, max = 500): Features {
  const x: number[] = [];
  const y: number[] = [];
  const size: number[] = [];
  const angle: number[] = [];
  const words: number[] = [];

  const sizes: Array<[number, number]> = [];
  for (let l = 0; l < LEVELS; l++) {
    const k = LEVEL_SCALE ** l;
    const w = Math.round(base.width / k);
    const h = Math.round(base.height / k);
    if (Math.min(w, h) < 2 * EDGE + 8) break;
    sizes.push([w, h]);
  }
  // Fewer features on the coarse levels, as in ORB.
  const factor = 1 / LEVEL_SCALE;
  const first = sizes.length > 0 ? (max * (1 - factor)) / (1 - factor ** sizes.length) : 0;

  for (let l = 0; l < sizes.length; l++) {
    const [w, h] = sizes[l];
    const level = resizeGray(base, w, h);
    const picked = selectCorners(level, Math.round(first * factor ** l));
    if (picked.length === 0) continue;
    const smooth = blur(level);
    const sx = base.width / w;
    const sy = base.height / h;
    for (const i of picked) {
      const cx = i % w;
      const cy = Math.floor(i / w);
      // Orientation: the direction from the patch centre to its intensity centroid.
      let m10 = 0;
      let m01 = 0;
      for (let u = -HALF_PATCH; u <= HALF_PATCH; u++) m10 += u * level.data[i + u];
      for (let v = 1; v <= HALF_PATCH; v++) {
        let rowSum = 0;
        for (let u = -U_MAX[v]; u <= U_MAX[v]; u++) {
          const below = level.data[i + v * w + u];
          const above = level.data[i - v * w + u];
          m10 += u * (below + above);
          rowSum += below - above;
        }
        m01 += v * rowSum;
      }
      const theta = Math.atan2(m01, m10);
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      for (let word = 0; word < DESCRIPTOR_WORDS; word++) {
        let bits = 0;
        for (let bit = 0; bit < 32; bit++) {
          const p = (word * 32 + bit) * 4;
          const ax = Math.round(PATTERN[p] * cos - PATTERN[p + 1] * sin);
          const ay = Math.round(PATTERN[p] * sin + PATTERN[p + 1] * cos);
          const bx = Math.round(PATTERN[p + 2] * cos - PATTERN[p + 3] * sin);
          const by = Math.round(PATTERN[p + 2] * sin + PATTERN[p + 3] * cos);
          if (smooth[i + ay * w + ax] < smooth[i + by * w + bx]) bits |= 1 << bit;
        }
        words.push(bits >>> 0);
      }
      x.push((cx + 0.5) * sx - 0.5);
      y.push((cy + 0.5) * sy - 0.5);
      size.push(PATCH * sx);
      angle.push(theta);
    }
  }
  return {
    width: base.width,
    height: base.height,
    count: x.length,
    x: Float32Array.from(x),
    y: Float32Array.from(y),
    size: Float32Array.from(size),
    angle: Float32Array.from(angle),
    descriptors: Uint32Array.from(words),
  };
}

/** Keys made from one feature. */
export const KEYS_PER_FEATURE = DESCRIPTOR_WORDS;

function mix(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b1, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h ^ b, 0xc2b2ae35);
  h ^= h >>> 13;
  return h | 0;
}

/**
 * Search keys: KEYS_PER_FEATURE for each feature, in feature order. A key is a
 * 32-bit hash of two neighbour words (64 bits) of the descriptor and their
 * place. A copy of a picture gives some of the same keys at the same spots; the
 * server finds candidates by key and gets no pixel and no position.
 */
export function featureKeys(features: Features): Int32Array {
  const keys = new Int32Array(features.count * KEYS_PER_FEATURE);
  for (let i = 0; i < features.count; i++) {
    const at = i * DESCRIPTOR_WORDS;
    for (let w = 0; w < DESCRIPTOR_WORDS; w++) {
      keys[at + w] = mix(mix(features.descriptors[at + w], features.descriptors[at + ((w + 1) % DESCRIPTOR_WORDS)]), w + 1);
    }
  }
  return keys;
}
