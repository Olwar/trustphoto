import { MAX_SENSOR_SAMPLES, SENSOR_WINDOW_MS, type SensorSample } from '@trustphoto/shared';

/** The samples from `windowMs` before `until` up to `until`, at most MAX_SENSOR_SAMPLES (the newest). */
export function selectWindow(samples: readonly SensorSample[], until: number, windowMs = SENSOR_WINDOW_MS): SensorSample[] {
  const window = samples.filter((s) => s.timestamp >= until - windowMs && s.timestamp <= until);
  return window.length > MAX_SENSOR_SAMPLES ? window.slice(-MAX_SENSOR_SAMPLES) : window;
}
