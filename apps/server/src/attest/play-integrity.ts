/**
 * Google Play Integrity (Android), standard requests.
 *
 * The phone asks Play Integrity for a token with requestHash = binding hash.
 * Google signs that hash into its verdict, so a decoded verdict whose
 * requestHash equals the binding hash the server computed proves that the
 * genuine Play-installed app, on a phone Google certifies, committed to
 * exactly these photo bytes and this motion trace.
 *
 * Decoding is done by Google (Google-managed response encryption):
 * POST https://playintegrity.googleapis.com/v1/<package>:decodeIntegrityToken
 * with a service-account OAuth token (JWT bearer grant, scope playintegrity).
 */

import { importPKCS8, SignJWT } from 'jose';
import { createWindowLimit } from '../limits.js';

export interface PlayIntegrityConfig {
  packageName: string | null;
  serviceAccount: { client_email: string; private_key: string; token_uri: string } | null;
}

export interface PlayIntegrityVerdict {
  requestHash: string | null;
  requestPackageName: string | null;
  timestampMillis: number | null;
  appRecognitionVerdict: string | null;
  deviceRecognitionVerdict: string[];
  appAccessRiskVerdict: string[] | null;
}

export type DecodeResult =
  | { ok: true; verdict: PlayIntegrityVerdict }
  | { ok: false; reason: 'unavailable' | 'invalid' | 'misconfigured' | 'throttled'; error: string };

const OAUTH_SCOPE = 'https://www.googleapis.com/auth/playintegrity';
const TIMEOUT_MS = 3000;

/** Pure projection of `tokenPayloadExternal` onto the fields TrustPhoto reads. */
export function parseIntegrityPayload(payload: unknown): PlayIntegrityVerdict {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, any>;
  const request = p.requestDetails ?? {};
  const app = p.appIntegrity ?? {};
  const device = p.deviceIntegrity ?? {};
  const apps = p.environmentDetails?.appAccessRiskVerdict?.appsDetected;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    requestHash: typeof request.requestHash === 'string' ? request.requestHash : null,
    requestPackageName: typeof request.requestPackageName === 'string' ? request.requestPackageName : null,
    timestampMillis: Number.isFinite(Number(request.timestampMillis)) ? Number(request.timestampMillis) : null,
    appRecognitionVerdict: typeof app.appRecognitionVerdict === 'string' ? app.appRecognitionVerdict : null,
    deviceRecognitionVerdict: strings(device.deviceRecognitionVerdict),
    appAccessRiskVerdict: Array.isArray(apps) ? strings(apps).slice(0, 8) : null,
  };
}

/** Parses PLAY_INTEGRITY_SA_JSON. Returns null for a missing or unusable key. */
export function parseServiceAccount(raw: string | undefined): PlayIntegrityConfig['serviceAccount'] {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') return null;
    return {
      client_email: parsed.client_email,
      private_key: parsed.private_key,
      token_uri: typeof parsed.token_uri === 'string' ? parsed.token_uri : 'https://oauth2.googleapis.com/token',
    };
  } catch {
    return null;
  }
}

/**
 * Installs that passed the device check before ("proven") and new installs
 * have separate per-minute budgets of Google calls. A flood of junk tokens
 * from new installs fills only the new-install lane, and those callers get
 * "throttled"; proven phones keep working.
 */
export type DecodeLane = 'proven' | 'unproven';
export const DEFAULT_LANE_LIMITS: Record<DecodeLane, number> = { proven: 600, unproven: 120 };

export function createPlayIntegrityDecoder(
  cfg: PlayIntegrityConfig,
  fetchImpl: typeof fetch = fetch,
  laneLimits: Record<DecodeLane, number> = DEFAULT_LANE_LIMITS,
) {
  let cached: { token: string; expiresAt: number } | null = null;
  const lanes = { proven: createWindowLimit(laneLimits.proven, 60_000), unproven: createWindowLimit(laneLimits.unproven, 60_000) };

  async function accessToken(sa: NonNullable<PlayIntegrityConfig['serviceAccount']>): Promise<string> {
    if (cached && Date.now() < cached.expiresAt - 5 * 60_000) return cached.token;
    const key = await importPKCS8(sa.private_key, 'RS256');
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: OAUTH_SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(sa.client_email)
      .setAudience(sa.token_uri)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
    const res = await fetchImpl(sa.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in?: number };
    cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return cached.token;
  }

  return async function decode(integrityToken: string, lane: DecodeLane = 'unproven'): Promise<DecodeResult> {
    const { serviceAccount, packageName } = cfg;
    if (!serviceAccount || !packageName) {
      return { ok: false, reason: 'misconfigured', error: 'PLAY_INTEGRITY_SA_JSON or PLAY_INTEGRITY_PACKAGE_NAME is not set' };
    }
    if (!lanes[lane]('google')) return { ok: false, reason: 'throttled', error: `${lane} lane full` };
    let token: string;
    try {
      token = await accessToken(serviceAccount);
    } catch (err) {
      return { ok: false, reason: 'unavailable', error: err instanceof Error ? err.message : String(err) };
    }
    try {
      const res = await fetchImpl(`https://playintegrity.googleapis.com/v1/${encodeURIComponent(packageName)}:decodeIntegrityToken`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ integrityToken }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // 400: Google read the token and rejected it. 401/403/429 and 5xx are
      // our credentials, our quota or Google: no evidence against the phone.
      if (res.status === 400) return { ok: false, reason: 'invalid', error: 'decode rejected: 400' };
      if (res.status === 401) cached = null;
      if (!res.ok) return { ok: false, reason: 'unavailable', error: `decode failed: ${res.status}` };
      const body = (await res.json()) as { tokenPayloadExternal?: unknown };
      return { ok: true, verdict: parseIntegrityPayload(body.tokenPayloadExternal ?? {}) };
    } catch (err) {
      return { ok: false, reason: 'unavailable', error: err instanceof Error ? err.message : String(err) };
    }
  };
}

export type PlayIntegrityDecoder = ReturnType<typeof createPlayIntegrityDecoder>;
