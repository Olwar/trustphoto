/**
 * The binding hash ties one capture together: the install that took it, the
 * server nonce it was taken under, the exact photo bytes and the motion trace
 * recorded around the shot. The phone's hardware key (App Attest on iOS) or
 * Google's verdict (Play Integrity on Android) commits to this one value, so
 * changing any part of the capture after the shot breaks the commitment.
 *
 *   bindingHash = SHA256(['tp1', installId, nonce, imageSha256, sensorDigest, deviceDigest].join('|'))
 *
 * The scheme is SocialHuman's, with the install ID in place of the user ID.
 * TrustPhoto also binds the phone details and the shutter time
 * (deviceDigest), because the proof page shows the phone model. The phone, the server and the test vectors in
 * __tests__/binding.test.ts must agree byte for byte.
 */

import { sha256 } from 'js-sha256';
import type { DeviceInfo, SensorSample } from './protocol';
import { MAX_SENSOR_SAMPLES } from './protocol';

export const BINDING_VERSION = 'tp1';

/**
 * Fixed-decimal float text. JSON.stringify is not safe here: number
 * formatting differs between Hermes, V8 and Postgres jsonb. Non-finite values
 * become zero so one bad sensor read cannot split the two sides.
 */
function fixed6(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(6) : '0.000000';
}

function intOrZero(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value).toString() : '0';
}

/** Canonical text of the motion trace: positional fields, ',' within a sample, ';' between samples. */
export function canonicalizeSensorSamples(samples: readonly Partial<SensorSample>[] | null | undefined): string {
  if (!Array.isArray(samples) || samples.length === 0) return '';
  const capped = samples.length > MAX_SENSOR_SAMPLES ? samples.slice(0, MAX_SENSOR_SAMPLES) : samples;
  return capped
    .map((s) => {
      const a = s?.accelerometer;
      const g = s?.gyroscope;
      return [fixed6(a?.x), fixed6(a?.y), fixed6(a?.z), fixed6(g?.x), fixed6(g?.y), fixed6(g?.z), intOrZero(s?.timestamp)].join(',');
    })
    .join(';');
}

/** SHA-256 of the canonical motion trace. An empty trace digests to ''. */
export function computeSensorDigest(samples: readonly Partial<SensorSample>[] | null | undefined): string {
  const canonical = canonicalizeSensorSamples(samples);
  return canonical ? sha256(canonical) : '';
}

/**
 * SHA-256 of the phone details and the shutter time. JSON of an array of
 * strings, booleans and one integer: the same bytes in Hermes and V8.
 */
export function computeDeviceDigest(info: DeviceInfo, captureTimestamp: number): string {
  return sha256(
    JSON.stringify([
      info.platform,
      info.brand ?? null,
      info.model ?? null,
      info.osVersion ?? null,
      info.appVersion ?? null,
      info.isDevice === true,
      info.hasGyroscope === true,
      Number.isFinite(captureTimestamp) ? Math.trunc(captureTimestamp) : 0,
    ]),
  );
}

export function computeBindingHash(parts: {
  installId: string;
  nonce: string;
  imageSha256: string;
  sensorDigest: string;
  deviceDigest: string;
}): string {
  return sha256([BINDING_VERSION, parts.installId, parts.nonce, parts.imageSha256, parts.sensorDigest, parts.deviceDigest].join('|'));
}

