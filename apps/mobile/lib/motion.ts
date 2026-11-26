/**
 * Records the accelerometer and the gyroscope while the camera is open: one
 * sample per accelerometer reading, paired with the latest gyroscope
 * reading, at about 60 Hz.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Accelerometer, Gyroscope } from 'expo-sensors';
import { SENSOR_WINDOW_MS, type SensorSample } from '@trustphoto/shared';
import { selectWindow } from './motion-window';

const INTERVAL_MS = 16;
/** Keep a little more than one shot window. */
const BUFFER_MS = SENSOR_WINDOW_MS + 3_000;

export function useMotionRecorder(active: boolean) {
  const samples = useRef<SensorSample[]>([]);
  const gyro = useRef({ x: 0, y: 0, z: 0 });
  const [hasGyroscope, setHasGyroscope] = useState(true);

  useEffect(() => {
    Gyroscope.isAvailableAsync()
      .then(setHasGyroscope)
      .catch(() => setHasGyroscope(false));
  }, []);

  useEffect(() => {
    if (!active) return;
    samples.current = [];
    Accelerometer.setUpdateInterval(INTERVAL_MS);
    Gyroscope.setUpdateInterval(INTERVAL_MS);
    const gyroSub = Gyroscope.addListener((g) => {
      gyro.current = { x: g.x, y: g.y, z: g.z };
    });
    const accelSub = Accelerometer.addListener((a) => {
      const now = Date.now();
      const buffer = samples.current;
      buffer.push({ accelerometer: { x: a.x, y: a.y, z: a.z }, gyroscope: { ...gyro.current }, timestamp: now });
      // Trim in batches, not on every sample.
      if (buffer.length > 600 && buffer[0].timestamp < now - BUFFER_MS) {
        samples.current = buffer.filter((s) => s.timestamp >= now - BUFFER_MS);
      }
    });
    return () => {
      accelSub.remove();
      gyroSub.remove();
    };
  }, [active]);

  /** The motion window that belongs to a shot taken just now. */
  const takeWindow = useCallback((until = Date.now()) => selectWindow(samples.current, until), []);

  return { takeWindow, hasGyroscope };
}
