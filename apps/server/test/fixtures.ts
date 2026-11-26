/**
 * Synthetic captures for the server tests. They prove the wiring, not how
 * real phone photos score: only real captures from real phones can do that.
 *
 * The plain fixtures here are enough for the reference photo checks, and the
 * test server runs the reference checks. A checks module of your own can
 * install its checks and its fixtures with `useCaptureFixtures` from a setup
 * file at private/photo-checks/test/setup.ts (see vitest.config.ts); without
 * one, the public tests always run the reference checks.
 */

import sharp from 'sharp';
import type { SensorSample } from '@trustphoto/shared';
import type { PhotoChecks } from '../src/checks/types.js';

/** Raw RGB pixels, 3 bytes per pixel. */
export interface RawPicture {
  data: Buffer;
  width: number;
  height: number;
}

export interface CaptureFixtures {
  /** The photo checks the test server runs with these fixtures. Not set: the reference checks. */
  checks?: PhotoChecks;
  /** A motion trace of `count` samples that ends at `endAt`. Different seeds give different traces. */
  motionTrace(seed: number, endAt: number, count?: number): SensorSample[];
  /**
   * Encodes a drawn picture as a phone camera would save it, with camera make, model and a GPS position in the EXIF.
   * `seed` and `takenAt` are there for fixtures that need them (the plain ones do not).
   */
  cameraJpeg(picture: RawPicture, seed: number, takenAt: number, camera: { make: string; model: string }): Promise<Buffer>;
}

export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 2 ** 32;
  };
}

/** A phone held still at a slight tilt: about 1 g, with a little noise so that each seed gives another trace. */
function plainTrace(seed: number, endAt: number, count = 160): SensorSample[] {
  const r = rng(seed);
  const samples: SensorSample[] = [];
  for (let i = 0; i < count; i++) {
    samples.push({
      accelerometer: { x: 0.05 + (r() - 0.5) * 0.01, y: -0.75 + (r() - 0.5) * 0.01, z: 0.66 + (r() - 0.5) * 0.01 },
      gyroscope: { x: (r() - 0.5) * 0.01, y: (r() - 0.5) * 0.01, z: (r() - 0.5) * 0.01 },
      timestamp: endAt - (count - i) * 16,
    });
  }
  return samples;
}

async function plainJpeg(picture: RawPicture, _seed: number, _takenAt: number, camera: { make: string; model: string }): Promise<Buffer> {
  return sharp(picture.data, { raw: { width: picture.width, height: picture.height, channels: 3 } })
    .jpeg()
    .withExif({
      IFD0: { Make: camera.make, Model: camera.model, Orientation: '1' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '60/1 10/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '24/1 56/1 0/1' },
    })
    .toBuffer();
}

export const plainFixtures: CaptureFixtures = { motionTrace: plainTrace, cameraJpeg: plainJpeg };

let active: CaptureFixtures = plainFixtures;

/** Replaces the fixtures for this test process. */
export function useCaptureFixtures(fixtures: CaptureFixtures): void {
  active = fixtures;
}

export function captureFixtures(): CaptureFixtures {
  return active;
}

/** The motion trace that a test capture sends. */
export function motionTrace(seed: number, endAt: number, count?: number): SensorSample[] {
  return active.motionTrace(seed, endAt, count);
}

/** A 1600x1200 outdoor scene that is different for each seed, saved as a camera photo. */
export async function phonePhoto(seed: number, takenAt: number): Promise<Buffer> {
  const W = 1600;
  const H = 1200;
  const r = rng(seed);
  const px = Buffer.alloc(W * H * 3);
  const cx = 300 + r() * 1000;
  const cy = 200 + r() * 700;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      const sky = y < H * (0.55 + 0.05 * Math.sin(x / 210 + seed));
      const d = Math.hypot(x - cx, y - cy);
      const blob = d < 160 ? 60 * (1 - d / 160) : 0;
      const tex = 14 * Math.sin(x / (17 + (seed % 5))) * Math.cos(y / 23) + (r() - 0.5) * 18;
      const base = sky ? [120 + y / 12, 150 + y / 14, 205 - y / 20] : [70 + (x % 97) / 6, 95 + y / 30, 55];
      px[o] = Math.max(0, Math.min(255, base[0] + tex + blob));
      px[o + 1] = Math.max(0, Math.min(255, base[1] + tex + blob * 0.8));
      px[o + 2] = Math.max(0, Math.min(255, base[2] + tex * 0.6));
    }
  }
  return active.cameraJpeg({ data: px, width: W, height: H }, seed, takenAt, { make: 'Google', model: 'Pixel 8' });
}
