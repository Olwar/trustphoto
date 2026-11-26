/**
 * mulberry32, a small fixed-seed pseudo-random generator by Tommy Ettinger
 * (public domain). It is not for secrets: it makes the same numbers in every
 * build and on every device, which the feature pattern and the alignment fit
 * need.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
