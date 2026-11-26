import { describe, expect, it } from 'vitest';
import { hammingDistance, isPhash, lumaGrid, PHASH_SIZE, phashFromLuma } from '../phash';

const N = PHASH_SIZE * PHASH_SIZE;

function scene(seed: number): Float64Array {
  const out = new Float64Array(N);
  for (let y = 0; y < PHASH_SIZE; y++) {
    for (let x = 0; x < PHASH_SIZE; x++) {
      out[y * PHASH_SIZE + x] =
        128 + 60 * Math.sin((x + seed) / 4) * Math.cos((y * seed) / 7) + 40 * Math.sin((x * y) / (30 + seed));
    }
  }
  return out;
}

describe('pHash', () => {
  it('returns 16 hex characters', () => {
    expect(isPhash(phashFromLuma(scene(3)))).toBe(true);
  });

  it('is stable under small brightness and noise changes', () => {
    const base = scene(3);
    let state = 42;
    const noisy = base.map((v) => {
      state = (state * 1103515245 + 12345) % 2 ** 31;
      return v * 1.05 + 6 + ((state / 2 ** 31) - 0.5) * 8;
    });
    expect(hammingDistance(phashFromLuma(base), phashFromLuma(noisy))).toBeLessThanOrEqual(4);
  });

  it('tells different pictures apart', () => {
    expect(hammingDistance(phashFromLuma(scene(3)), phashFromLuma(scene(11)))).toBeGreaterThan(16);
  });

  it('reads RGB and RGBA buffers the same way', () => {
    const rgb = new Uint8Array(N * 3);
    const rgba = new Uint8Array(N * 4);
    for (let i = 0; i < N; i++) {
      const [r, g, b] = [(i * 7) % 256, (i * 13) % 256, (i * 29) % 256];
      rgb.set([r, g, b], i * 3);
      rgba.set([r, g, b, 255], i * 4);
    }
    expect(Array.from(lumaGrid(rgb, 3))).toEqual(Array.from(lumaGrid(rgba, 4)));
  });

  it('counts differing bits', () => {
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hammingDistance('00000000000000f0', '0000000000000000')).toBe(4);
    expect(() => hammingDistance('xyz', '0000000000000000')).toThrow();
  });
});
