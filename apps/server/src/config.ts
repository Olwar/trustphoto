import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseServiceAccount, type PlayIntegrityConfig } from './attest/play-integrity.js';
import type { AppAttestConfig } from './attest/app-attest.js';

export interface AppConfig {
  port: number;
  host: string;
  /** Origin of the website and the API, without a trailing slash. */
  publicBaseUrl: string;
  production: boolean;
  databaseUrl: string | undefined;
  /** Embedded database, local photo files and the development signing key. */
  dataDir: string | null;
  s3: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region?: string; forcePathStyle?: boolean } | null;
  signingKeyPem: string | null;
  /** Public keys (PEM) of earlier signing keys, still published so old receipts check. */
  retiredSigningPublicKeys: string[];
  /**
   * Only a hardware-bound device check (App Attest / Play Integrity) may
   * verify. Always on in production; development builds cannot pass it, so
   * without it their proofs are marked as test proofs.
   */
  requireAttestation: boolean;
  allowEmulator: boolean;
  appAttest: AppAttestConfig;
  playIntegrity: PlayIntegrityConfig;
  /** Secret for short-lived signed URLs and for hashing reporter IPs. */
  urlSecret: string;
  /**
   * The header your proxy writes with the client address and overwrites when
   * a client sends it (Fly: fly-client-ip, Cloudflare: cf-connecting-ip).
   * Unset: the socket address. X-Forwarded-For is never trusted: clients can
   * write its first entry.
   */
  clientIpHeader: string | null;
  /** Verifications running at once on this instance. */
  verifyConcurrency: number;
  /** Uploads being received or checked at once on this instance (each holds up to 15 MB). */
  maxUploadsInFlight: number;
  /** Google calls a day for all installs that never passed the device check together. Keep well below the Play Integrity quota. */
  unprovenDailyGoogleCalls: number;
  /** Shown on the website: who runs the service, where to ask for removal, the store links. */
  site: { operator: string | null; contactEmail: string | null; appStoreUrl: string | null; playStoreUrl: string | null };
}

export function flag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

function bucketFrom(endpoint?: string, bucket?: string, accessKeyId?: string, secretAccessKey?: string): AppConfig['s3'] {
  return endpoint && bucket && accessKeyId && secretAccessKey ? { endpoint, bucket, accessKeyId, secretAccessKey } : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const production = env.NODE_ENV === 'production';
  const port = Number(env.PORT ?? 8787);
  const dataDir = env.DATA_DIR === '' ? null : resolve(env.DATA_DIR ?? '.data');
  // `fly storage create` sets the AWS_* names on the app. The S3_* names win when both are complete.
  const s3Found =
    bucketFrom(env.S3_ENDPOINT, env.S3_BUCKET, env.S3_ACCESS_KEY_ID, env.S3_SECRET_ACCESS_KEY) ??
    bucketFrom(env.AWS_ENDPOINT_URL_S3, env.BUCKET_NAME, env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY);
  // R2 and AWS take the defaults; MinIO and most self-hosted S3 servers need S3_FORCE_PATH_STYLE=true.
  const s3: AppConfig['s3'] = s3Found
    ? { ...s3Found, region: env.S3_REGION?.trim() || undefined, forcePathStyle: flag(env.S3_FORCE_PATH_STYLE, false) }
    : null;
  const s3Names = [env.S3_ENDPOINT, env.S3_BUCKET, env.S3_ACCESS_KEY_ID, env.S3_SECRET_ACCESS_KEY].filter(Boolean).length;
  const s3Partial = s3Names > 0 && s3Names < 4;

  const cfg: AppConfig = {
    port: Number.isInteger(port) && port > 0 ? port : 8787,
    host: env.HOST ?? '0.0.0.0',
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    production,
    databaseUrl: env.DATABASE_URL || undefined,
    dataDir,
    s3,
    signingKeyPem: env.TRUSTPHOTO_SIGNING_KEY?.replace(/\\n/g, '\n') || null,
    retiredSigningPublicKeys: parsePemList(env.TRUSTPHOTO_RETIRED_PUBLIC_KEYS),
    requireAttestation: production || flag(env.REQUIRE_ATTESTATION, false),
    allowEmulator: !production && flag(env.ALLOW_EMULATOR, false),
    // The app's entitlement is the production App Attest environment, also in development builds.
    appAttest: { appId: env.APP_ATTEST_APP_ID || null, development: !production && flag(env.APP_ATTEST_DEVELOPMENT, false) },
    playIntegrity: { packageName: env.PLAY_INTEGRITY_PACKAGE_NAME || null, serviceAccount: parseServiceAccount(env.PLAY_INTEGRITY_SA_JSON) },
    urlSecret: env.URL_SECRET ?? '',
    clientIpHeader: env.CLIENT_IP_HEADER?.toLowerCase() || null,
    verifyConcurrency: Math.max(1, Number.parseInt(env.VERIFY_CONCURRENCY ?? '', 10) || 2),
    maxUploadsInFlight: Math.max(1, Number.parseInt(env.MAX_UPLOADS_IN_FLIGHT ?? '', 10) || 16),
    unprovenDailyGoogleCalls: Math.max(1, Number.parseInt(env.UNPROVEN_DAILY_GOOGLE_CALLS ?? '', 10) || 3000),
    site: {
      operator: env.OPERATOR_NAME || null,
      contactEmail: env.CONTACT_EMAIL || null,
      appStoreUrl: env.APP_STORE_URL || null,
      playStoreUrl: env.PLAY_STORE_URL || null,
    },
  };

  if (production) {
    const missing = [
      !cfg.databaseUrl && 'DATABASE_URL',
      !cfg.s3 && 'S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY',
      // A half-set S3_* group is a mistake; it must not fall through to the names Fly set.
      s3Partial && 'all four of S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY (only some are set)',
      !cfg.signingKeyPem && 'TRUSTPHOTO_SIGNING_KEY',
      cfg.urlSecret.length < 32 && 'URL_SECRET (32+ characters)',
      !env.PUBLIC_BASE_URL && 'PUBLIC_BASE_URL',
      !cfg.clientIpHeader && 'CLIENT_IP_HEADER',
      // The device check is required in production: without these, every capture on that platform fails.
      !cfg.appAttest.appId && 'APP_ATTEST_APP_ID',
      !cfg.playIntegrity.packageName && 'PLAY_INTEGRITY_PACKAGE_NAME',
      !cfg.playIntegrity.serviceAccount && 'PLAY_INTEGRITY_SA_JSON (a service-account key JSON)',
      // The privacy page names the operator and the address for removal requests.
      !cfg.site.operator && 'OPERATOR_NAME',
      !cfg.site.contactEmail && 'CONTACT_EMAIL',
    ].filter(Boolean);
    if (missing.length > 0) throw new Error(`Missing production settings: ${missing.join(', ')}`);
  } else if (!cfg.urlSecret) {
    // A new random secret for each development process: no fixed secret is ever published with the code.
    cfg.urlSecret = randomBytes(32).toString('hex');
  }
  return cfg;
}

/** A JSON array of PEM strings; anything else is an empty list. */
function parsePemList(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string' && v.includes('PUBLIC KEY')) : [];
  } catch {
    return [];
  }
}

export const devSigningKeyPath = (cfg: AppConfig) => (cfg.dataDir ? join(cfg.dataDir, 'signing-key.pem') : null);
