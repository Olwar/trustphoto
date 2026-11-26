/**
 * Decides if one picture is a copy of (a part of) another one, without either
 * side seeing the other's pixels.
 *
 * 1. Spots that have the same search key in both pictures are paired.
 * 2. RANSAC finds the one shift, turn and zoom that most pairs agree on.
 * 3. A grid is laid over the part that the two pictures share under that
 *    transform. Each side makes one bit for each cell from its own pixels: is
 *    the cell brighter than the cells around it? A copy agrees on most bits.
 *    Another photo of the same scene agrees on about half, as chance does.
 *
 * The browser does steps 1 and 2 and sends its bits; the server makes its own
 * bits from the stored photo and decides. The bits are a hash of fine detail.
 */

import type { Gray } from './features';
import { mulberry32 } from './random';

/** Query coordinates to candidate coordinates: x' = a x - b y + tx, y' = b x + a y + ty. */
export interface Similarity {
  a: number;
  b: number;
  tx: number;
  ty: number;
}

/** One spot in the query (qx, qy) and the spot in the candidate (cx, cy) that has the same key. */
export interface PointPair {
  qx: number;
  qy: number;
  cx: number;
  cy: number;
}

export interface Frame {
  width: number;
  height: number;
}

const RANSAC_ROUNDS = 2000;
/** A pair agrees with a transform when it lands this close, in candidate pixels. */
const INLIER_PIXELS = 4;
/** Cells on each side of the grid laid over the shared part. */
export const GRID = 48;
/** A cell is compared against the mean of the cells up to this far around it, so only fine detail counts. */
const SURROUND = 2;
/** A cell needs this many cells around it (itself included) to give a bit. */
const MIN_SURROUND_CELLS = 9;

/** Least-squares similarity over the given pairs. */
function fit(pairs: PointPair[], use: number[]): Similarity | null {
  const n = use.length;
  if (n < 2) return null;
  let qx = 0;
  let qy = 0;
  let cx = 0;
  let cy = 0;
  for (const i of use) {
    qx += pairs[i].qx;
    qy += pairs[i].qy;
    cx += pairs[i].cx;
    cy += pairs[i].cy;
  }
  qx /= n;
  qy /= n;
  cx /= n;
  cy /= n;
  let dot = 0;
  let cross = 0;
  let norm = 0;
  for (const i of use) {
    const ux = pairs[i].qx - qx;
    const uy = pairs[i].qy - qy;
    const vx = pairs[i].cx - cx;
    const vy = pairs[i].cy - cy;
    dot += ux * vx + uy * vy;
    cross += ux * vy - uy * vx;
    norm += ux * ux + uy * uy;
  }
  if (norm < 1e-6) return null;
  const a = dot / norm;
  const b = cross / norm;
  return { a, b, tx: cx - (a * qx - b * qy), ty: cy - (b * qx + a * qy) };
}

function agreeing(pairs: PointPair[], t: Similarity): number[] {
  const out: number[] = [];
  const limit = INLIER_PIXELS * INLIER_PIXELS;
  for (let i = 0; i < pairs.length; i++) {
    const dx = t.a * pairs[i].qx - t.b * pairs[i].qy + t.tx - pairs[i].cx;
    const dy = t.b * pairs[i].qx + t.a * pairs[i].qy + t.ty - pairs[i].cy;
    if (dx * dx + dy * dy <= limit) out.push(i);
  }
  return out;
}

/** Pairs that are different spots: two keys of one feature make the same pair twice. */
function distinctSpots(pairs: PointPair[], use: number[]): number {
  const spots = new Set<string>();
  for (const i of use) spots.add(`${Math.round(pairs[i].cx)},${Math.round(pairs[i].cy)}`);
  return spots.size;
}

/**
 * The transform most pairs agree on, and how many different spots agree. The
 * same input always gives the same answer.
 */
export function fitSimilarity(pairs: PointPair[]): { transform: Similarity; inliers: number } | null {
  if (pairs.length < 3) return null;
  const next = mulberry32(0x636f7079);
  let best: number[] = [];
  let bestSpots = 0;
  let bestTransform: Similarity | null = null;
  for (let round = 0; round < RANSAC_ROUNDS; round++) {
    const i = Math.floor(next() * pairs.length);
    let j = Math.floor(next() * (pairs.length - 1));
    if (j >= i) j++;
    const t = fit(pairs, [i, j]);
    if (!t) continue;
    const zoom = Math.hypot(t.a, t.b);
    if (zoom < 0.15 || zoom > 6.5) continue;
    const inliers = agreeing(pairs, t);
    // Different spots count, not pairs: many pairs of two spots must not hide a transform that more spots agree on.
    if (inliers.length <= bestSpots) continue;
    const spots = distinctSpots(pairs, inliers);
    if (spots > bestSpots) {
      best = inliers;
      bestSpots = spots;
      bestTransform = t;
    }
  }
  if (!bestTransform || bestSpots < 3) return null;
  // Refit on the agreeing pairs, twice: the two-pair guess is rough.
  for (let pass = 0; pass < 2; pass++) {
    const refit = fit(pairs, best);
    if (!refit) break;
    const inliers = agreeing(pairs, refit);
    const spots = distinctSpots(pairs, inliers);
    if (spots < bestSpots) break;
    best = inliers;
    bestSpots = spots;
    bestTransform = refit;
  }
  return { transform: bestTransform, inliers: bestSpots };
}

/** Sums of all pixels above and left of each point, for fast box means. */
export interface Integral {
  width: number;
  height: number;
  sums: Float64Array;
}

export function integralOf(gray: Gray): Integral {
  const { width, height, data } = gray;
  const w = width + 1;
  const sums = new Float64Array(w * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += data[y * width + x];
      sums[(y + 1) * w + x + 1] = sums[y * w + x + 1] + row;
    }
  }
  return { width, height, sums };
}

/** Mean brightness of a square around a point, cut at the picture border. */
function boxMean(image: Integral, cx: number, cy: number, half: number): number {
  const x0 = Math.min(image.width - 1, Math.max(0, Math.floor(cx - half)));
  const y0 = Math.min(image.height - 1, Math.max(0, Math.floor(cy - half)));
  const x1 = Math.min(image.width, Math.max(x0 + 1, Math.ceil(cx + half)));
  const y1 = Math.min(image.height, Math.max(y0 + 1, Math.ceil(cy + half)));
  const w = image.width + 1;
  const sum = image.sums[y1 * w + x1] - image.sums[y0 * w + x1] - image.sums[y1 * w + x0] + image.sums[y0 * w + x0];
  return sum / ((x1 - x0) * (y1 - y0));
}

/** The part of a convex polygon inside a rectangle (Sutherland-Hodgman). */
function clipToRect(polygon: Array<[number, number]>, width: number, height: number): Array<[number, number]> {
  const edges: Array<(p: [number, number]) => number> = [(p) => p[0], (p) => width - p[0], (p) => p[1], (p) => height - p[1]];
  let out = polygon;
  for (const inside of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i];
      const b = input[(i + 1) % input.length];
      const da = inside(a);
      const db = inside(b);
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db);
        out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      }
    }
    if (out.length === 0) return out;
  }
  return out;
}

function areaOf(polygon: Array<[number, number]>): number {
  let twice = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(twice) / 2;
}

/** The grid over the part that the query and the candidate share. Both sides build it from the same numbers. */
export interface SharedGrid {
  /** Share of the candidate picture that the query shows (0 to 1). */
  ofCandidate: number;
  /** Share of the query picture that is the candidate (0 to 1). */
  ofQuery: number;
  /** Cell centres in the candidate (x, y) and in the query (x, y), GRID * GRID of each. */
  candidateX: Float64Array;
  candidateY: Float64Array;
  queryX: Float64Array;
  queryY: Float64Array;
  /** Half the side of a cell, in candidate and in query pixels. */
  halfCandidate: number;
  halfQuery: number;
  /** 1: the cell is inside both pictures. */
  inside: Uint8Array;
}

/** The zoom of a transform that the grid accepts: a copy from 20 times smaller to 20 times larger than the stored photo. */
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 20;

/**
 * Null when the two pictures share no usable part under `t`. The cells are
 * squares that do not overlap, so each counted cell is its own piece of the
 * picture: a thin strip gives few cells, not many copies of one cell.
 */
export function sharedGrid(t: Similarity, query: Frame, candidate: Frame): SharedGrid | null {
  const zoom2 = t.a * t.a + t.b * t.b;
  if (![t.a, t.b, t.tx, t.ty].every(Number.isFinite) || zoom2 < MIN_ZOOM * MIN_ZOOM || zoom2 > MAX_ZOOM * MAX_ZOOM) return null;
  const map = (x: number, y: number): [number, number] => [t.a * x - t.b * y + t.tx, t.b * x + t.a * y + t.ty];
  const frame = [map(0, 0), map(query.width, 0), map(query.width, query.height), map(0, query.height)];
  const shared = clipToRect(frame, candidate.width, candidate.height);
  if (shared.length < 3) return null;
  const area = areaOf(shared);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of shared) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const step = Math.max(maxX - minX, maxY - minY) / GRID;
  const zoom = Math.sqrt(zoom2);
  // A cell under one pixel on either side has no detail to compare.
  if (!(step >= 1) || step / zoom < 1) return null;
  const halfCandidate = step / 2;
  const halfQuery = halfCandidate / zoom;
  const n = GRID * GRID;
  const grid: SharedGrid = {
    ofCandidate: area / (candidate.width * candidate.height),
    ofQuery: area / (zoom2 * query.width * query.height),
    candidateX: new Float64Array(n),
    candidateY: new Float64Array(n),
    queryX: new Float64Array(n),
    queryY: new Float64Array(n),
    halfCandidate,
    halfQuery,
    inside: new Uint8Array(n),
  };
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const i = gy * GRID + gx;
      const cx = minX + (gx + 0.5) * step;
      const cy = minY + (gy + 0.5) * step;
      // Candidate point back to the query (the inverse of `t`).
      const dx = cx - t.tx;
      const dy = cy - t.ty;
      const qx = (t.a * dx + t.b * dy) / zoom2;
      const qy = (-t.b * dx + t.a * dy) / zoom2;
      grid.candidateX[i] = cx;
      grid.candidateY[i] = cy;
      grid.queryX[i] = qx;
      grid.queryY[i] = qy;
      // Inside the shared part, with one pixel of margin in the file: the two sides must agree on a border cell in spite of rounding.
      const inCandidate = cx + halfCandidate <= maxX + 1e-6 && cy + halfCandidate <= maxY + 1e-6;
      const inQuery = qx >= halfQuery + 1 && qy >= halfQuery + 1 && qx <= query.width - halfQuery - 1 && qy <= query.height - halfQuery - 1;
      grid.inside[i] = inCandidate && inQuery ? 1 : 0;
    }
  }
  return grid;
}

/**
 * Fine detail of one side: for each cell, its mean brightness less the mean of
 * the cells around it. NaN where the cell has no bit. The two sides use the
 * same cells for the surround, so a crop border or the page around a
 * screenshot does not count.
 */
export function cellDetail(image: Integral, grid: SharedGrid, side: 'query' | 'candidate'): Float64Array {
  const n = GRID * GRID;
  const xs = side === 'query' ? grid.queryX : grid.candidateX;
  const ys = side === 'query' ? grid.queryY : grid.candidateY;
  const half = side === 'query' ? grid.halfQuery : grid.halfCandidate;
  const means = new Float64Array(n);
  for (let i = 0; i < n; i++) if (grid.inside[i]) means[i] = boxMean(image, xs[i], ys[i], half);
  const detail = new Float64Array(n).fill(NaN);
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const i = gy * GRID + gx;
      if (!grid.inside[i]) continue;
      let sum = 0;
      let count = 0;
      for (let ny = Math.max(0, gy - SURROUND); ny <= Math.min(GRID - 1, gy + SURROUND); ny++) {
        for (let nx = Math.max(0, gx - SURROUND); nx <= Math.min(GRID - 1, gx + SURROUND); nx++) {
          const j = ny * GRID + nx;
          if (!grid.inside[j]) continue;
          sum += means[j];
          count++;
        }
      }
      if (count >= MIN_SURROUND_CELLS) detail[i] = means[i] - sum / count;
    }
  }
  return detail;
}

/** One bit for each cell (1: brighter than its surround), packed, as lowercase hex. GRID * GRID / 4 characters. */
export function detailBits(detail: Float64Array): string {
  let hex = '';
  for (let i = 0; i < detail.length; i += 4) {
    let nibble = 0;
    for (let k = 0; k < 4; k++) nibble = (nibble << 1) | (detail[i + k] > 0 ? 1 : 0);
    hex += nibble.toString(16);
  }
  return hex;
}

export const DETAIL_BITS_HEX = /^[0-9a-f]{576}$/;

export interface Agreement {
  /** Cells with clear detail in the stored photo. The bits of the other cells are noise and do not count. */
  cells: number;
  /** Share of those cells where the query's bit is the stored photo's bit. Chance gives 0.5. */
  agreement: number;
}

/** Compares the query's bits with the stored photo's own detail. `minStrength`: brightness steps (of 255) a cell must stand out by. */
export function compareDetail(queryBits: string, stored: Float64Array, minStrength = 1.5): Agreement {
  let cells = 0;
  let same = 0;
  for (let i = 0; i < stored.length; i++) {
    const v = stored[i];
    if (Number.isNaN(v) || Math.abs(v) < minStrength) continue;
    const bit = (parseInt(queryBits[i >> 2], 16) >> (3 - (i & 3))) & 1;
    cells++;
    if (bit === (v > 0 ? 1 : 0)) same++;
  }
  return { cells, agreement: cells === 0 ? 0 : same / cells };
}

/** Turn of the query against the candidate, whole degrees, 0 to 359. */
export function rotationOf(t: Similarity): number {
  return ((Math.round((Math.atan2(t.b, t.a) * 180) / Math.PI) % 360) + 360) % 360;
}

/** The transform that puts the whole query frame onto the whole candidate frame after a quarter turn (0, 90, 180 or 270). */
export function wholeFrameTransform(query: Frame, candidate: Frame, rotation: 0 | 90 | 180 | 270): Similarity {
  const { width: qw, height: qh } = query;
  const { width: cw, height: ch } = candidate;
  const upright = (cw / qw + ch / qh) / 2;
  const turned = (cw / qh + ch / qw) / 2;
  switch (rotation) {
    case 0:
      return { a: upright, b: 0, tx: 0, ty: 0 };
    case 90:
      return { a: 0, b: turned, tx: cw, ty: 0 };
    case 180:
      return { a: -upright, b: 0, tx: cw, ty: ch };
    default:
      return { a: 0, b: -turned, tx: 0, ty: ch };
  }
}
