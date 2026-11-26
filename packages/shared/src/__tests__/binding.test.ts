import { describe, expect, it } from 'vitest';
import { canonicalizeSensorSamples, computeBindingHash, computeDeviceDigest, computeSensorDigest } from '../binding';
import { MAX_SENSOR_SAMPLES } from '../protocol';

const SAMPLES = [
  { accelerometer: { x: 0.01, y: -0.98, z: 0.12 }, gyroscope: { x: 0.001, y: 0.002, z: -0.003 }, timestamp: 1764000000000 },
  { accelerometer: { x: 0.0123456789, y: -0.981, z: 0.1201 }, gyroscope: { x: 0, y: -0, z: 0.5 }, timestamp: 1764000000016.7 },
];

describe('binding hash', () => {
  it('writes samples as fixed decimals and integer timestamps', () => {
    expect(canonicalizeSensorSamples(SAMPLES)).toBe(
      '0.010000,-0.980000,0.120000,0.001000,0.002000,-0.003000,1764000000000;' +
        '0.012346,-0.981000,0.120100,0.000000,0.000000,0.500000,1764000000016',
    );
  });

  it('turns non-finite readings into zero instead of splitting the two sides', () => {
    const bad = [{ accelerometer: { x: NaN, y: Infinity, z: 1 }, gyroscope: { x: 0, y: 0, z: 0 }, timestamp: NaN }];
    expect(canonicalizeSensorSamples(bad)).toBe('0.000000,0.000000,1.000000,0.000000,0.000000,0.000000,0');
  });

  it('digests an empty trace to an empty string', () => {
    expect(computeSensorDigest([])).toBe('');
    expect(computeSensorDigest(null)).toBe('');
  });

  it('hashes only the first MAX_SENSOR_SAMPLES samples', () => {
    const many = Array.from({ length: MAX_SENSOR_SAMPLES + 5 }, (_, i) => ({ ...SAMPLES[0], timestamp: i }));
    expect(computeSensorDigest(many)).toBe(computeSensorDigest(many.slice(0, MAX_SENSOR_SAMPLES)));
  });

  // Pinned vector: the phone and the server import this same module, but a
  // pinned value still catches an accidental change to the preimage.
  it('matches the pinned vector', () => {
    const sensorDigest = computeSensorDigest(SAMPLES);
    expect(sensorDigest).toBe('075819493ba200996be984624cc79dbf61544df4cd541e00f8b5d8f7ff228f9e');
    const hash = computeBindingHash({
      installId: '7d3f7a7e-2f4e-4a51-9d0b-1f2a3b4c5d6e',
      nonce: '0b9c8d7e-6f5a-4b3c-8d2e-1f0a9b8c7d6e',
      imageSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      sensorDigest,
      deviceDigest: computeDeviceDigest(DEVICE, 1764000000020.9),
    });
    expect(computeDeviceDigest(DEVICE, 1764000000020.9)).toBe('ae8f241c1455cfc4d4fa9b77a264839dc6a3f1afbc053492a3004e8aeb4213b2');
    expect(hash).toBe(PINNED_BINDING_HASH);
  });

  it('binds the phone details and the shutter time', () => {
    const d = computeDeviceDigest(DEVICE, 1);
    expect(computeDeviceDigest({ ...DEVICE, model: 'Example Staff Camera' }, 1)).not.toBe(d);
    expect(computeDeviceDigest(DEVICE, 2)).not.toBe(d);
  });

  it('changes when any part changes', () => {
    const base = { installId: 'i', nonce: 'n', imageSha256: 'a'.repeat(64), sensorDigest: 'd', deviceDigest: 'x' };
    const h = computeBindingHash(base);
    expect(computeBindingHash({ ...base, installId: 'j' })).not.toBe(h);
    expect(computeBindingHash({ ...base, nonce: 'm' })).not.toBe(h);
    expect(computeBindingHash({ ...base, imageSha256: 'b'.repeat(64) })).not.toBe(h);
    expect(computeBindingHash({ ...base, sensorDigest: 'e' })).not.toBe(h);
    expect(computeBindingHash({ ...base, deviceDigest: 'y' })).not.toBe(h);
  });
});

const DEVICE = { platform: 'ios', brand: 'Apple', model: 'iPhone 15 Pro', osVersion: '18.1', appVersion: '1.0.0', isDevice: true, hasGyroscope: true } as const;

// Cross-checked with Python hashlib and json.dumps(separators=(',', ':')) over the same preimages.
const PINNED_BINDING_HASH = '8fbd5f2cb76429226591937e8ebf1dfc0c786164a693c28aa169aa1c292fe41a';
