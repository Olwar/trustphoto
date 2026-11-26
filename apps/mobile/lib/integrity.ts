/**
 * The hardware commitment over a capture's binding hash.
 *
 * iOS: an App Attest key (Secure Enclave) is attested once per install, then
 * signs the binding hash for every photo.
 * Android: a Play Integrity standard request with requestHash = binding hash.
 *
 * When no commitment is possible the server gets { type: 'none', reason }
 * and the photo cannot become a real proof. The one error that is thrown is
 * AppAttestKeyInvalidError: the stored key is gone, and the caller makes a
 * new one.
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { AttestationPayload } from '@trustphoto/shared';
import { apiFetch } from './api';
import type { Install } from './install';

interface AppIntegrityModule {
  isSupported: boolean;
  generateKeyAsync(): Promise<string>;
  attestKeyAsync(keyId: string, challenge: string): Promise<string>;
  generateAssertionAsync(keyId: string, challenge: string): Promise<string>;
  prepareIntegrityTokenProviderAsync(cloudProjectNumber: string): Promise<void>;
  requestIntegrityCheckAsync(requestHash: string): Promise<string>;
}

const TIMEOUT_MS = 5_000;

/**
 * The stored App Attest key no longer works (a restore to a new phone).
 * Thrown so the caller can make a new key BEFORE it fetches the next nonce:
 * the key setup can take 20 s, longer than a nonce may wait.
 */
export class AppAttestKeyInvalidError extends Error {}
const CEREMONY_TIMEOUT_MS = 20_000;
const CLOUD_PROJECT_NUMBER = process.env.EXPO_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER ?? '';

function loadModule(): AppIntegrityModule | null {
  try {
    // Lazy so a build without the native module degrades instead of crashing.
    return require('@expo/app-integrity') as AppIntegrityModule;
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

const keyIdStoreKey = (installId: string) => `trustphoto.appattest.${installId}`;
/** One key setup per install, shared by concurrent callers. */
const ceremonies = new Map<string, Promise<string>>();

/** Makes and registers this install's App Attest key once. */
function ensureAppAttestKey(mod: AppIntegrityModule, install: Install, forceNew = false): Promise<string> {
  const running = ceremonies.get(install.installId);
  if (running && !forceNew) return running;
  const ceremony = (async () => {
    const stored = forceNew ? null : await SecureStore.getItemAsync(keyIdStoreKey(install.installId));
    if (stored) return stored;
    const keyId = await mod.generateKeyAsync();
    const { challenge } = await apiFetch<{ challenge: string }>('/v1/app-attest/challenge', { method: 'POST', token: install.token });
    const attestation = await mod.attestKeyAsync(keyId, challenge);
    await apiFetch('/v1/app-attest/register', { method: 'POST', token: install.token, body: JSON.stringify({ keyId, challenge, attestation }) });
    await SecureStore.setItemAsync(keyIdStoreKey(install.installId), keyId);
    return keyId;
  })().catch((err) => {
    ceremonies.delete(install.installId);
    throw err;
  });
  ceremonies.set(install.installId, ceremony);
  return ceremony;
}

/**
 * Everything slow that does not depend on the photo: the one-time key setup
 * (iOS) or the token provider (Android). Runs before the nonce is fetched,
 * so the nonce is not spent while it waits. Never throws.
 */
export async function prepareCommitment(install: Install, opts: { newKey?: boolean } = {}): Promise<void> {
  const mod = loadModule();
  if (!mod) return;
  try {
    if (Platform.OS === 'ios' && mod.isSupported) await withTimeout(ensureAppAttestKey(mod, install, opts.newKey), CEREMONY_TIMEOUT_MS);
    if (Platform.OS === 'android' && CLOUD_PROJECT_NUMBER) await prepareAndroid(mod);
  } catch {
    // getCommitment reports the failure as { type: 'none' }.
  }
}

/** Starts the one-time iOS key setup early, so the first photo does not wait for it. */
export function warmUpIntegrity(install: Install): void {
  const mod = loadModule();
  if (Platform.OS === 'ios' && mod?.isSupported) ensureAppAttestKey(mod, install).catch(() => undefined);
  if (Platform.OS === 'android' && mod && CLOUD_PROJECT_NUMBER) prepareAndroid(mod).catch(() => undefined);
}

let androidProvider: Promise<void> | null = null;
function prepareAndroid(mod: AppIntegrityModule, again = false): Promise<void> {
  if (!androidProvider || again) {
    androidProvider = withTimeout(mod.prepareIntegrityTokenProviderAsync(CLOUD_PROJECT_NUMBER), TIMEOUT_MS).catch((err) => {
      androidProvider = null;
      throw err;
    });
  }
  return androidProvider;
}

export async function getCommitment(bindingHash: string, install: Install): Promise<AttestationPayload> {
  const mod = loadModule();
  if (!mod) return { type: 'none', reason: 'module_missing' };

  if (Platform.OS === 'ios') {
    if (!mod.isSupported) return { type: 'none', reason: 'ios_unsupported' };
    let keyId: string;
    try {
      // prepareCommitment already ran the setup; this only reads the result.
      keyId = await withTimeout(ensureAppAttestKey(mod, install), TIMEOUT_MS);
    } catch {
      return { type: 'none', reason: 'ios_no_key' };
    }
    try {
      return { type: 'app_attest', keyId, assertion: await withTimeout(mod.generateAssertionAsync(keyId, bindingHash), TIMEOUT_MS) };
    } catch (err) {
      if (err instanceof Error && err.message === 'timeout') return { type: 'none', reason: 'ios_assertion_timeout' };
      throw new AppAttestKeyInvalidError('assertion failed');
    }
  }

  if (Platform.OS === 'android') {
    if (!CLOUD_PROJECT_NUMBER) return { type: 'none', reason: 'android_no_project' };
    try {
      await prepareAndroid(mod);
      try {
        return { type: 'play_integrity', token: await withTimeout(mod.requestIntegrityCheckAsync(bindingHash), TIMEOUT_MS) };
      } catch {
        // A prepared provider goes stale (Play error -19): prepare again once.
        await prepareAndroid(mod, true);
        return { type: 'play_integrity', token: await withTimeout(mod.requestIntegrityCheckAsync(bindingHash), TIMEOUT_MS) };
      }
    } catch {
      return { type: 'none', reason: 'android_token_failed' };
    }
  }

  return { type: 'none', reason: 'unsupported_platform' };
}
