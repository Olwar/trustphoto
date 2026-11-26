/**
 * The app's real upload code (apps/mobile/lib: install, integrity, capture,
 * api) against the real server over HTTP. It proves the two sides agree on
 * routes, headers, part names and order, the bundle fields, the binding hash
 * and the device-key ceremony.
 *
 * Replaced, because they need a phone: the native modules (camera file read,
 * SHA-256, keychain, phone details, App Attest / Play Integrity) and React
 * Native's FormData file part, which reads the photo from disk as RN does.
 * Apple's one-time key attestation needs Apple's CA, so that one verifier is
 * replaced too; the per-photo assertion is verified for real.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureResult, SensorSample } from '@trustphoto/shared';
import { makeAppAttestKey } from './appattest.js';
import { motionTrace, phonePhoto } from './fixtures.js';

const APP_ID = 'TEAMID.com.socialhuman.trustphoto';
const platform = { OS: 'android' as 'ios' | 'android' };
const keychain = new Map<string, string>();

vi.mock('react-native', () => ({ Platform: platform }));
// The phone details follow the platform, as on a real phone.
vi.mock('expo-device', () => ({
  get brand() {
    return platform.OS === 'ios' ? 'Apple' : 'google';
  },
  get modelName() {
    return platform.OS === 'ios' ? 'iPhone 15 Pro' : 'Pixel 8';
  },
  get osVersion() {
    return platform.OS === 'ios' ? '18.1' : '15';
  },
  isDevice: true,
}));
vi.mock('expo-application', () => ({ nativeApplicationVersion: '1.0.0' }));
vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digest: async (_algorithm: string, bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest()).buffer,
}));
vi.mock('expo-file-system', () => ({
  File: class {
    constructor(readonly uri: string) {}
    async bytes() {
      return new Uint8Array(await readFile(this.uri.replace('file://', '')));
    }
  },
}));
vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
  getItemAsync: async (key: string) => keychain.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void keychain.set(key, value),
}));

// The one-time Apple attestation: the fake phone sends its public key and the challenge it attested.
vi.mock('../src/attest/app-attest.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/attest/app-attest.js')>();
  return {
    ...real,
    verifyKeyAttestation: vi.fn(async (_cfg: unknown, _keyId: string, challenge: string, attestation: string) => {
      const attested = JSON.parse(Buffer.from(attestation, 'base64').toString()) as { challenge: string; publicKeyPem: string };
      return attested.challenge === challenge
        ? { ok: true as const, publicKeyPem: attested.publicKeyPem, signCount: 0 }
        : { ok: false as const, reason: 'invalid_attestation' as const, error: 'wrong challenge' };
    }),
  };
});

/** integrity.ts loads the native module with require(): put a fake phone in Node's module cache. */
const mobileLib = resolve(import.meta.dirname, '../../mobile/lib');
const nativeRequire = createRequire(join(mobileLib, 'integrity.ts'));
const nativePath = nativeRequire.resolve('@expo/app-integrity');
const phone = {
  keys: new Map<string, { key: ReturnType<typeof makeAppAttestKey>; count: number }>(),
  attested: [] as string[],
};
nativeRequire.cache[nativePath] = {
  id: nativePath,
  filename: nativePath,
  loaded: true,
  exports: {
    isSupported: true,
    generateKeyAsync: async () => {
      const keyId = `key-${phone.keys.size + 1}`;
      phone.keys.set(keyId, { key: makeAppAttestKey(APP_ID), count: 0 });
      return keyId;
    },
    attestKeyAsync: async (keyId: string, challenge: string) => {
      phone.attested.push(challenge);
      return Buffer.from(JSON.stringify({ challenge, publicKeyPem: phone.keys.get(keyId)!.key.publicKeyPem })).toString('base64');
    },
    generateAssertionAsync: async (keyId: string, challenge: string) => {
      const entry = phone.keys.get(keyId);
      if (!entry) throw new Error('invalid key');
      return entry.key.assert(challenge, ++entry.count);
    },
    prepareIntegrityTokenProviderAsync: async () => undefined,
    // Google signs the request hash into its verdict; the test decoder reads the verdict JSON.
    requestIntegrityCheckAsync: async (requestHash: string) =>
      JSON.stringify({
        requestHash,
        requestPackageName: 'com.socialhuman.trustphoto',
        timestampMillis: Date.now(),
        appRecognitionVerdict: 'PLAY_RECOGNIZED',
        deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'],
        appAccessRiskVerdict: null,
      }),
  },
} as unknown as NodeJS.Module;

/** React Native's FormData sends `{ uri, name, type }` as a file read from disk. */
class PhoneFormData extends FormData {
  override append(name: string, value: unknown, fileName?: string): void {
    const file = value as { uri?: string; name?: string; type?: string };
    if (file && typeof file === 'object' && typeof file.uri === 'string') {
      super.append(name, new Blob([readFileSync(file.uri.replace('file://', ''))], { type: file.type }), file.name);
    } else if (fileName === undefined) {
      super.append(name, value as string);
    } else {
      super.append(name, value as Blob, fileName);
    }
  }
}

interface Shot {
  uri: string;
  samples: SensorSample[];
  captureTimestamp: number;
  hasGyroscope: boolean;
}

const { createHarness } = await import('./harness.js');
type Harness = Awaited<ReturnType<typeof createHarness>>;

let h: Harness;
let dir: string;

beforeAll(async () => {
  h = await createHarness({ APP_ATTEST_APP_ID: APP_ID });
  const address = await h.app.listen({ port: 0, host: '127.0.0.1' });
  process.env.EXPO_PUBLIC_API_URL = address;
  process.env.EXPO_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER = '1234567890';
  vi.stubGlobal('FormData', PhoneFormData);
  dir = await mkdtemp(join(tmpdir(), 'trustphoto-phone-'));
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await h.close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  // A fresh app start: no cached install, no cached key setup.
  vi.resetModules();
});

async function takeShot(): Promise<Shot> {
  const captureTimestamp = Date.now() - 800;
  // A random scene and motion trace for each shot, as in harness.ts.
  const seed = Math.floor(Math.random() * 1e9);
  const uri = `file://${join(dir, `shot-${seed}.jpg`)}`;
  await writeFile(uri.replace('file://', ''), await phonePhoto(seed, captureTimestamp));
  return { uri, samples: motionTrace(seed, captureTimestamp), captureTimestamp, hasGyroscope: true };
}

/** The app's own module, loaded after the environment is set (api.ts reads it at import). */
async function app(): Promise<{ sendShot(shot: Shot): Promise<CaptureResult> }> {
  return import(/* @vite-ignore */ join(mobileLib, 'capture.ts'));
}

describe('the app talks to the server', () => {
  it('Android: registers the install and gets a real proof', async () => {
    platform.OS = 'android';
    keychain.clear();
    const installs = () => h.ctx.db.query<{ platform: string }>("SELECT platform FROM installs WHERE platform = 'android'");
    const before = (await installs()).rows.length;
    const result = await (await app()).sendShot(await takeShot());
    expect(result).toMatchObject({ status: 'verified' });
    if (result.status !== 'verified') return;
    expect(result.photo.isTest).toBe(false);
    expect(result.photo.device).toBe('Google Pixel 8');
    expect(result.photo.checks.find((c) => c.key === 'device')).toEqual({ key: 'device', state: 'passed' });

    expect((await installs()).rows).toHaveLength(before + 1);
  });

  it('iPhone: sets up the device key once, then signs each photo with it', async () => {
    platform.OS = 'ios';
    keychain.clear();
    const { sendShot } = await app();
    const attestedBefore = phone.attested.length;
    const first = await sendShot(await takeShot());
    const second = await sendShot(await takeShot());
    for (const result of [first, second]) {
      expect(result.status).toBe('verified');
      if (result.status === 'verified') expect(result.photo.isTest).toBe(false);
    }
    expect(phone.attested).toHaveLength(attestedBefore + 1);
  });

  it('iPhone: makes a new device key when the server does not know the stored one', async () => {
    platform.OS = 'ios';
    keychain.clear();
    const { sendShot } = await app();
    expect((await sendShot(await takeShot())).status).toBe('verified');
    // The server lost the key (a restored database).
    await h.ctx.db.query('UPDATE installs SET app_attest_key_id = NULL, app_attest_public_key_pem = NULL WHERE platform = $1', ['ios']);
    const attestedBefore = phone.attested.length;
    const result = await sendShot(await takeShot());
    expect(result).toMatchObject({ status: 'verified', photo: { isTest: false } });
    expect(phone.attested).toHaveLength(attestedBefore + 1);
  });

  it('a phone with no device check gets a test proof, never a real one', async () => {
    platform.OS = 'android';
    keychain.clear();
    delete process.env.EXPO_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER;
    try {
      const result = await (await app()).sendShot(await takeShot());
      expect(result.status).toBe('verified');
      if (result.status === 'verified') expect(result.photo.isTest).toBe(true);
    } finally {
      process.env.EXPO_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER = '1234567890';
    }
  });
});
