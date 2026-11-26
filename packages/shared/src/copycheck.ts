/**
 * "Is this file a copy of a verified photo?" for copies that the exact hash and
 * the whole-picture pHash cannot settle: cropped, mirrored, turned, tilted, in
 * a screenshot. The steps, and who does them:
 *
 *   browser  queryCode()        search keys of the file (hashes, no pixels)
 *   server   finds the photos that share keys; sends the shared keys' spots
 *   browser  alignToCandidate() the shift, turn and zoom that fit
 *   browser  queryBits()        one bit of fine detail for each grid cell
 *   server   judgeBits()        compares the bits with the stored photo
 *
 * The server decides. It gets no pixel values of the checked file: it gets
 * hashes of feature descriptors (with enough work, the descriptors can be
 * worked out from them, but not where in the picture they are), and, for a
 * candidate, one bit for each grid cell with the transform. The browser gets
 * no pixel of a photo before the server confirmed the match.
 */

import { extractFeatures, featureKeys, fitInside, KEYS_PER_FEATURE, FEATURE_SIZE, FEATURE_INPUT_MAX, mirrorGray, prepareGray, resizeGray, type Gray } from './features';
import {
  cellDetail,
  compareDetail,
  detailBits,
  fitSimilarity,
  integralOf,
  rotationOf,
  sharedGrid,
  wholeFrameTransform,
  type Frame,
  type Integral,
  type PointPair,
  type Similarity,
} from './match';
import { ORIENTATIONS, orientedPhashes } from './phash';
import type { ConfirmRequest, LookupResult } from './protocol';

/** Features kept for a stored photo, and for each size of a checked file. */
export const FEATURES_PER_PICTURE = 500;
/** Most keys one lookup may carry: three sizes of the checked file. */
export const MAX_QUERY_KEYS = 3 * FEATURES_PER_PICTURE * KEYS_PER_FEATURE;
/** A stored photo must share this many keys with the file to become a candidate. */
export const MIN_SHARED_KEYS = 5;
/** Candidates the server names for one lookup. */
export const MAX_CANDIDATES = 3;
/**
 * Spots that must agree on one transform before the browser asks for a decision
 * and sends its detail bits. Plain corners give the same key in any picture, so
 * a few spots agree by chance; in the tests an unrelated file passed a limit of
 * 5 for two candidates of three, and this limit for one of 25.
 */
export const MIN_ALIGNED_SPOTS = 10;
/** Share of detail bits that must agree. Chance gives 0.5; copies in the tests give 0.9 and more; other pictures stay under 0.75. */
export const MIN_AGREEMENT = 0.8;
/** Cells with clear detail that the decision needs. */
export const MIN_DETAIL_CELLS = 150;
/** A key that many spots of one photo share (a repeated pattern) cannot place a spot. */
const MAX_SPOTS_PER_KEY = 3;
/** Stored positions are whole numbers: pixels times this. */
export const SPOT_SCALE = 16;

/** What the server stores for a photo: keys in feature order, one position for each feature. */
export interface StoredCode {
  width: number;
  height: number;
  keys: Int32Array;
  x: Float32Array;
  y: Float32Array;
}

/** `gray` is the photo at `frameOf` its size. */
export function storedCode(gray: Gray): StoredCode {
  const features = extractFeatures(gray, FEATURES_PER_PICTURE);
  return { width: gray.width, height: gray.height, keys: featureKeys(features), x: features.x, y: features.y };
}

/** The size of the grey picture that a photo's keys and bits refer to. */
export function frameOf(width: number, height: number): Frame {
  return fitInside(width, height, FEATURE_SIZE);
}

/** The checked file as a grey picture at long side FEATURE_SIZE. Spots, transforms and bits refer to this frame. */
export interface QueryFrame {
  gray: Gray;
  integral: Integral;
}

/** The checked file with its search keys: one key and one position for each entry. */
export interface QueryCode extends QueryFrame {
  keys: Int32Array;
  x: Float32Array;
  y: Float32Array;
}

function checkInput(full: Gray): void {
  if (Math.max(full.width, full.height) > FEATURE_INPUT_MAX) throw new Error('decode the file to FEATURE_INPUT_MAX or smaller');
}

/** `full` is the file at a long side of at most FEATURE_INPUT_MAX. */
export function queryFrame(full: Gray): QueryFrame {
  checkInput(full);
  const gray = prepareGray(full);
  return { gray, integral: integralOf(gray) };
}

/**
 * Keys of the checked file at three sizes. A stored photo has keys at one
 * size, so a crop (the content is larger) or a screenshot (it is smaller)
 * shares keys with it at one of the three.
 */
export function queryCode(full: Gray, frame: QueryFrame = queryFrame(full)): QueryCode {
  checkInput(full);
  const { gray } = frame;
  const long = Math.max(full.width, full.height);
  const sizes = [FEATURE_SIZE, FEATURE_SIZE / 2];
  if (long >= FEATURE_SIZE * 1.5) sizes.unshift(long);
  const keys: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  const done = new Set<number>();
  for (const size of sizes) {
    const fit = fitInside(full.width, full.height, size);
    // A small file gives the same picture at two of the sizes: once is enough.
    if (done.has(fit.width * 65536 + fit.height)) continue;
    done.add(fit.width * 65536 + fit.height);
    const picture = fit.width === gray.width && fit.height === gray.height ? gray : resizeGray(full, fit.width, fit.height);
    const features = extractFeatures(picture, FEATURES_PER_PICTURE);
    const scaleX = gray.width / picture.width;
    const scaleY = gray.height / picture.height;
    featureKeys(features).forEach((key, i) => {
      const f = Math.floor(i / KEYS_PER_FEATURE);
      keys.push(key);
      x.push((features.x[f] + 0.5) * scaleX - 0.5);
      y.push((features.y[f] + 0.5) * scaleY - 0.5);
    });
  }
  return { ...frame, keys: Int32Array.from(keys), x: Float32Array.from(x), y: Float32Array.from(y) };
}

/** Keys as base64 of little-endian 32-bit numbers, for the wire. */
export function packKeys(keys: Int32Array): string {
  const bytes = new Uint8Array(keys.length * 4);
  const view = new DataView(bytes.buffer);
  keys.forEach((key, i) => view.setInt32(i * 4, key, true));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x2000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return btoa(binary);
}

/** Null when the text is not base64 of whole 32-bit numbers. */
export function unpackKeys(packed: string): Int32Array | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(packed)) return null;
  const binary = atob(packed);
  if (binary.length % 4 !== 0) return null;
  const view = new DataView(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) view.setUint8(i, binary.charCodeAt(i));
  const keys = new Int32Array(binary.length / 4);
  for (let i = 0; i < keys.length; i++) keys[i] = view.getInt32(i * 4, true);
  return keys;
}

/** A spot of a stored photo that has one of the file's keys: key, x, y (in the photo's frame). */
export type SharedSpot = [key: number, x: number, y: number];

/** The spots of a stored photo that share a key with the file. */
export function sharedSpots(stored: { keys: ArrayLike<number>; x: ArrayLike<number>; y: ArrayLike<number> }, queryKeys: Set<number>, scale = 1): SharedSpot[] {
  const spots: SharedSpot[] = [];
  for (let i = 0; i < stored.keys.length; i++) {
    if (!queryKeys.has(stored.keys[i])) continue;
    const f = Math.floor(i / KEYS_PER_FEATURE);
    spots.push([stored.keys[i], stored.x[f] / scale, stored.y[f] / scale]);
  }
  return spots;
}

/** The transform that puts the file onto the candidate, when enough spots agree on one. */
export function alignToCandidate(query: QueryCode, spots: SharedSpot[]): { transform: Similarity; spots: number } | null {
  const byKey = new Map<number, Array<[number, number]>>();
  for (const [key, x, y] of spots) {
    const list = byKey.get(key);
    if (list) list.push([x, y]);
    else byKey.set(key, [[x, y]]);
  }
  const pairs: PointPair[] = [];
  for (let i = 0; i < query.keys.length; i++) {
    const hits = byKey.get(query.keys[i]);
    if (!hits || hits.length > MAX_SPOTS_PER_KEY) continue;
    for (const [cx, cy] of hits) pairs.push({ qx: query.x[i], qy: query.y[i], cx, cy });
  }
  const fitted = fitSimilarity(pairs);
  return fitted && fitted.inliers >= MIN_ALIGNED_SPOTS ? { transform: fitted.transform, spots: fitted.inliers } : null;
}

/** The file's detail bits for the part it shares with the candidate. Null when they share no usable part. */
export function queryBits(query: QueryFrame, transform: Similarity, candidate: Frame): string | null {
  const grid = sharedGrid(transform, query.gray, candidate);
  return grid ? detailBits(cellDetail(query.integral, grid, 'query')) : null;
}

/** For a full copy that is not cropped: the transform after a quarter turn, and the bits under it. */
export function wholeFrameBits(query: QueryFrame, candidate: Frame, rotation: 0 | 90 | 180 | 270): { transform: Similarity; bits: string } | null {
  const transform = wholeFrameTransform(query.gray, candidate, rotation);
  const bits = queryBits(query, transform, candidate);
  return bits ? { transform, bits } : null;
}

/** How the file sits against the stored photo. */
export interface MatchShape {
  /** Turn of the file against the photo, degrees clockwise, 0 to 359. */
  rotation: number;
  /** Share of the photo that the file shows, 0 to 1. Under 1: the file is a crop. */
  ofPhoto: number;
  /** Share of the file that is the photo, 0 to 1. Under 1: the file has more around it (a screenshot). */
  ofFile: number;
}

export interface Judgement {
  match: boolean;
  agreement: number;
  cells: number;
  shape: MatchShape | null;
}

/** The server's decision: the stored photo's own detail against the bits the browser sent. */
export function judgeBits(photo: Gray, bits: string, transform: Similarity, file: Frame): Judgement {
  const grid = sharedGrid(transform, file, photo);
  if (!grid) return { match: false, agreement: 0, cells: 0, shape: null };
  const { agreement, cells } = compareDetail(bits, cellDetail(integralOf(photo), grid, 'candidate'));
  const shape = { rotation: rotationOf(transform), ofPhoto: Math.min(1, grid.ofCandidate), ofFile: Math.min(1, grid.ofQuery) };
  return { match: cells >= MIN_DETAIL_CELLS && agreement >= MIN_AGREEMENT, agreement, cells, shape };
}

/** What the browser has of the file. `full` is asked for only when the exact hash did not settle it. */
export interface CheckInput {
  sha256: string;
  /** The file as a 32x32 luma grid (see phash.ts). */
  luma: ArrayLike<number>;
  /** The file as a grey picture at a long side of at most FEATURE_INPUT_MAX. */
  full: () => Gray | Promise<Gray>;
}

export interface CheckOutcome {
  /** 'exact', 'similar' or 'none': never 'candidates'. */
  result: LookupResult;
  /** The file is a mirror image of the photo. Only the browser knows this. */
  mirrored: boolean;
}

/**
 * The whole check, cheapest step first:
 *   1. the exact hash, and the pHash of the file in its eight orientations;
 *   2. for a pHash candidate, the detail bits of the full frame;
 *   3. search keys of the file, then of its mirror image, for crops, tilts and screenshots.
 * `post` sends one JSON request and gives the answer. `onSlowStep` is called before step 3.
 */
export async function checkFile(
  input: CheckInput,
  post: (path: '/v1/lookup' | '/v1/lookup/confirm', body: unknown) => Promise<LookupResult>,
  onSlowStep?: () => void | Promise<void>,
): Promise<CheckOutcome> {
  const first = await post('/v1/lookup', { v: 2, sha256: input.sha256, phashes: orientedPhashes(input.luma) });
  if (first.match === 'exact') return { result: first, mirrored: false };

  let full: Gray | null = null;
  const frames = new Map<boolean, QueryFrame>();
  const frameFor = async (mirrored: boolean): Promise<{ full: Gray; frame: QueryFrame }> => {
    full ??= await input.full();
    const picture = mirrored ? mirrorGray(full) : full;
    let frame = frames.get(mirrored);
    if (!frame) frames.set(mirrored, (frame = queryFrame(picture)));
    return { full: picture, frame };
  };
  // A photo may be like the file, but it has too little clear detail for the server to decide.
  let unclear = false;
  const confirm = async (token: string, frame: QueryFrame, transform: Similarity, bits: string, mirrored: boolean): Promise<CheckOutcome | null> => {
    const request: ConfirmRequest = { token, frame: { width: frame.gray.width, height: frame.gray.height }, transform, bits };
    const answer = await post('/v1/lookup/confirm', request);
    if (answer.match === 'none' && answer.unclear) unclear = true;
    return answer.match === 'similar' ? { result: answer, mirrored } : null;
  };

  if (first.match === 'candidates') {
    for (const candidate of first.candidates) {
      const orientation = candidate.orientation === undefined ? undefined : ORIENTATIONS[candidate.orientation];
      if (!orientation) continue;
      const { frame } = await frameFor(orientation.mirrored);
      const whole = wholeFrameBits(frame, candidate, orientation.rotation);
      const outcome = whole && (await confirm(candidate.token, frame, whole.transform, whole.bits, orientation.mirrored));
      if (outcome) return outcome;
    }
  }

  await onSlowStep?.();
  for (const mirrored of [false, true]) {
    const { full: picture, frame } = await frameFor(mirrored);
    const query = queryCode(picture, frame);
    // A plain picture (a wall, a clear sky) has no features, so it has no keys to search with.
    if (query.keys.length === 0) continue;
    const found = await post('/v1/lookup', { v: 2, keys: packKeys(query.keys) });
    if (found.match !== 'candidates') continue;
    for (const candidate of found.candidates) {
      const aligned = candidate.spots && alignToCandidate(query, candidate.spots);
      const bits = aligned && queryBits(query, aligned.transform, candidate);
      const outcome = aligned && bits ? await confirm(candidate.token, query, aligned.transform, bits, mirrored) : null;
      if (outcome) return outcome;
    }
  }
  return { result: unclear ? { match: 'none', unclear: true } : { match: 'none' }, mirrored: false };
}
