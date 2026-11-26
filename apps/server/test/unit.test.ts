import { describe, expect, it } from 'vitest';
import { verifyCommitment, type AppAttestKeyStore } from '../src/attest/commitment.js';
import { parseIntegrityPayload } from '../src/attest/play-integrity.js';
import { deviceLabel } from '../src/services/captures.js';
import { canonicalJson } from '../src/signing.js';
import { newPhotoId, isPhotoId } from '../src/ids.js';

const noKeys: AppAttestKeyStore = { get: async () => null, advance: async () => true };
const base = {
  installId: 'i',
  bindingHash: 'b'.repeat(64),
  appAttest: { appId: 'TEAM.com.socialhuman.trustphoto', development: false },
  keys: noKeys,
  playPackageName: 'com.socialhuman.trustphoto',
};

describe('verifyCommitment', () => {
  const decodeAs = (payload: object) => async () => ({ ok: true as const, verdict: parseIntegrityPayload(payload) });
  const good = {
    requestDetails: { requestHash: 'b'.repeat(64), requestPackageName: 'com.socialhuman.trustphoto', timestampMillis: String(Date.now()) },
    appIntegrity: { appRecognitionVerdict: 'PLAY_RECOGNIZED' },
    deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'] },
  };
  const run = (payload: object) =>
    verifyCommitment({ ...base, attestation: { type: 'play_integrity', token: 't' }, decodePlayIntegrity: decodeAs(payload) });

  it('passes a fresh, matching, certified verdict', async () => {
    expect(await run(good)).toMatchObject({ verdict: 'pass', bound: true });
  });
  it('fails a verdict for another package or a stale one', async () => {
    expect((await run({ ...good, requestDetails: { ...good.requestDetails, requestPackageName: 'evil.app' } })).verdict).toBe('fail');
    expect((await run({ ...good, requestDetails: { ...good.requestDetails, timestampMillis: String(Date.now() - 11 * 60_000) } })).verdict).toBe('fail');
  });
  it('is inconclusive for a sideloaded app, and flags an uncertified phone', async () => {
    expect(await run({ ...good, appIntegrity: { appRecognitionVerdict: 'UNRECOGNIZED_VERSION' } })).toMatchObject({ verdict: 'inconclusive', bound: false });
    expect(await run({ ...good, deviceIntegrity: {} })).toMatchObject({ verdict: 'inconclusive', deviceNotCertified: true });
  });
  it('fails a token Google rejects, and is inconclusive when Google cannot be reached', async () => {
    const reject = async () => ({ ok: false as const, reason: 'invalid' as const, error: '' });
    const down = async () => ({ ok: false as const, reason: 'unavailable' as const, error: '' });
    expect((await verifyCommitment({ ...base, attestation: { type: 'play_integrity', token: 't' }, decodePlayIntegrity: reject })).verdict).toBe('fail');
    expect(await verifyCommitment({ ...base, attestation: { type: 'play_integrity', token: 't' }, decodePlayIntegrity: down })).toMatchObject({ verdict: 'inconclusive', transient: true });
  });
  it('is inconclusive for an App Attest key this install never registered', async () => {
    const out = await verifyCommitment({ ...base, attestation: { type: 'app_attest', keyId: 'k', assertion: 'AA==' }, decodePlayIntegrity: decodeAs(good) });
    expect(out).toMatchObject({ verdict: 'inconclusive', reason: 'unknown_key' });
  });
  it('fails an App Attest assertion that does not verify', async () => {
    const keys: AppAttestKeyStore = {
      get: async () => ({ publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----', signCount: 1 }),
      advance: async () => true,
    };
    const out = await verifyCommitment({ ...base, keys, attestation: { type: 'app_attest', keyId: 'k', assertion: 'AAAA' }, decodePlayIntegrity: decodeAs(good) });
    expect(out.verdict).toBe('fail');
  });
});

describe('helpers', () => {
  it('labels the device without repeating the brand', () => {
    const info = { platform: 'ios' as const, osVersion: null, appVersion: null, isDevice: true, hasGyroscope: true };
    expect(deviceLabel({ ...info, brand: 'Apple', model: 'iPhone 15 Pro' })).toBe('Apple iPhone 15 Pro');
    expect(deviceLabel({ ...info, brand: 'samsung', model: 'SM-S921B' })).toBe('Samsung SM-S921B');
    expect(deviceLabel({ ...info, brand: 'Google', model: 'Google Pixel 8' })).toBe('Google Pixel 8');
    expect(deviceLabel({ ...info, brand: '<script>', model: null })).toBe('Script');
    expect(deviceLabel({ ...info, brand: null, model: null })).toBeNull();
  });
  it('writes canonical JSON with sorted keys at every level', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 'x' }, u: undefined })).toBe('{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}');
  });
  it('makes 12-character base62 photo IDs', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newPhotoId()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(isPhotoId(id)).toBe(true);
  });
});
