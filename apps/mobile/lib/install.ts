/**
 * TrustPhoto has no accounts. The first launch registers an install with the
 * server and keeps its token in the keychain / keystore.
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { apiFetch, ApiError } from './api';

export interface Install {
  installId: string;
  token: string;
}

const KEY = 'trustphoto.install.v1';
const STORE_OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

let current: Promise<Install> | null = null;

async function loadOrRegister(): Promise<Install> {
  const saved = await SecureStore.getItemAsync(KEY, STORE_OPTIONS);
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as Install;
      if (parsed.installId && parsed.token) return parsed;
    } catch {
      // Unreadable value: register again below.
    }
  }
  return register();
}

async function register(): Promise<Install> {
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  const created = await apiFetch<Install>('/v1/installs', { method: 'POST', body: JSON.stringify({ platform }) });
  await SecureStore.setItemAsync(KEY, JSON.stringify(created), STORE_OPTIONS);
  return created;
}

/** The install, registered on first use. Concurrent callers share one request. */
export function getInstall(): Promise<Install> {
  current ??= loadOrRegister().catch((err) => {
    current = null;
    throw err;
  });
  return current;
}

/**
 * Runs `fn` with the install. Only when TrustPhoto itself says it no longer
 * knows the token (code 'unauthorized': its data was reset) does the app
 * register again; any other 401 (a proxy, a captive portal) leaves the token
 * alone, because the token is the only right to delete earlier photos. The
 * old token is replaced only after the new registration succeeded.
 */
export async function withInstall<T>(fn: (install: Install) => Promise<T>): Promise<T> {
  const install = await getInstall();
  try {
    return await fn(install);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401 || err.code !== 'unauthorized') throw err;
    current = register();
    const fresh = await current.catch((e) => {
      current = null;
      throw e;
    });
    return fn(fresh);
  }
}
