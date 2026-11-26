import { describe, expect, it } from 'vitest';
import { MAX_SENSOR_SAMPLES, SENSOR_WINDOW_MS } from '@trustphoto/shared';
import { selectWindow } from '../motion-window';

const sample = (timestamp: number) => ({ accelerometer: { x: 0, y: 0, z: 1 }, gyroscope: { x: 0, y: 0, z: 0 }, timestamp });

describe('selectWindow', () => {
  it('keeps only the motion from the window before the shot', () => {
    const samples = [0, 500, 1000, 2000, 3500, 4000, 4100].map(sample);
    expect(selectWindow(samples, 4000).map((s) => s.timestamp)).toEqual([1000, 2000, 3500, 4000]);
  });

  it('never sends more samples than the server hashes, keeping the newest', () => {
    const samples = Array.from({ length: MAX_SENSOR_SAMPLES + 50 }, (_, i) => sample(10_000 + i * (SENSOR_WINDOW_MS / (MAX_SENSOR_SAMPLES + 100))));
    const window = selectWindow(samples, samples.at(-1)!.timestamp);
    expect(window).toHaveLength(MAX_SENSOR_SAMPLES);
    expect(window.at(-1)).toBe(samples.at(-1));
  });
});
