import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  computeBindingHash,
  computeDeviceDigest,
  computeSensorDigest,
  type AttestationPayload,
  type CaptureBundle,
  type SensorSample,
} from '@trustphoto/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Context } from '../src/context.js';
import { migrate, openDb } from '../src/db/index.js';
import { localStorage } from '../src/storage.js';
import { loadSigner } from '../src/signing.js';
import { sha256Hex } from '../src/ids.js';
import type { PlayIntegrityVerdict } from '../src/attest/play-integrity.js';
import type { ScreenCheckResult } from '../src/checks/types.js';
import { createReferenceChecks } from '../src/checks/reference.js';
import { captureFixtures, motionTrace, phonePhoto } from './fixtures.js';
import { createConcurrencyLimit } from '../src/limits.js';

export const BASE_URL = 'https://trustphoto.test';

export interface Harness {
  app: FastifyInstance;
  ctx: Context;
  clock: { offsetMs: number };
  screenAnswers: ScreenCheckResult[];
  close(): Promise<void>;
}

/**
 * The real app on an in-memory Postgres and a temp folder. Only the two
 * outside services are fakes: Google's Play Integrity decoder (the test
 * "token" is the verdict JSON itself) and the vision model.
 */
export async function createHarness(env: Record<string, string> = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'trustphoto-test-'));
  const cfg = loadConfig({ NODE_ENV: 'test', PUBLIC_BASE_URL: BASE_URL, PLAY_INTEGRITY_PACKAGE_NAME: 'com.socialhuman.trustphoto', ...env });
  const testDb = await createTestDatabase();
  const db = await openDb({ dataDir: null, databaseUrl: testDb?.url });
  await migrate(db);
  const clock = { offsetMs: 0 };
  const screenAnswers: ScreenCheckResult[] = [];
  const ctx: Context = {
    cfg,
    // The reference checks, unless a setup file installed other checks (see fixtures.ts).
    checks: captureFixtures().checks ?? createReferenceChecks(),
    db,
    storage: localStorage(join(dir, 'media')),
    signer: await loadSigner({ pem: null, devKeyPath: null }),
    decodePlayIntegrity: async (token) => {
      try {
        return { ok: true, verdict: JSON.parse(token) as PlayIntegrityVerdict };
      } catch {
        return { ok: false, reason: 'invalid', error: 'not json' };
      }
    },
    screenCheck: async () => screenAnswers.shift() ?? { screen: null, confidence: null, reason: null, model: 'fake', error: 'not_configured' },
    now: () => Date.now() + clock.offsetMs,
    limitVerification: createConcurrencyLimit(2),
  };
  const app = await buildApp(ctx, {
    site: { baseUrl: cfg.publicBaseUrl, ...cfg.site, visionProvider: ctx.checks.visionProvider },
    publicDir: resolve(import.meta.dirname, '../../web/public/assets'),
  });
  return {
    app,
    ctx,
    clock,
    screenAnswers,
    async close() {
      await app.close();
      await db.close();
      await testDb?.drop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * With TEST_DATABASE_URL (a Postgres the tests may create databases on),
 * each harness gets its own fresh database, so the suite also runs on the
 * production driver. Without it, the embedded Postgres in memory.
 */
export async function createTestDatabase(): Promise<{ url: string; drop(): Promise<void> } | null> {
  const admin = process.env.TEST_DATABASE_URL;
  if (!admin) return null;
  const { default: pg } = await import('pg');
  const name = `trustphoto_test_${randomUUID().replace(/-/g, '')}`;
  const client = new pg.Client({ connectionString: admin });
  await client.connect();
  await client.query(`CREATE DATABASE ${name}`);
  await client.end();
  const url = new URL(admin);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    async drop() {
      const c = new pg.Client({ connectionString: admin });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

let ipCounter = 1;

export async function registerInstall(app: FastifyInstance, platform: 'ios' | 'android' = 'android') {
  const res = await app.inject({ method: 'POST', url: '/v1/installs', payload: { platform }, remoteAddress: `10.0.0.${ipCounter++}` });
  const body = res.json() as { installId: string; token: string };
  return { ...body, auth: { authorization: `Bearer ${body.token}` } };
}

export async function getNonce(app: FastifyInstance, auth: Record<string, string>): Promise<string> {
  return (await app.inject({ method: 'POST', url: '/v1/nonce', headers: auth })).json().nonce;
}

export function multipart(bundle: unknown, photo: Buffer) {
  const boundary = `----trustphoto${randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="bundle"\r\n\r\n${JSON.stringify(bundle)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    photo,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

export interface CaptureOptions {
  seed?: number;
  photo?: Buffer;
  samples?: SensorSample[];
  nonce?: string;
  /** Default: a genuine Play Integrity verdict over the right binding hash. */
  attestation?: AttestationPayload | ((bindingHash: string) => AttestationPayload);
  deviceInfo?: Partial<CaptureBundle['deviceInfo']>;
  imageSha256?: string;
  /** Changes the phone details after the device check committed to them. */
  tamperDeviceInfo?: Partial<CaptureBundle['deviceInfo']>;
  /** Client address. Default: a new one per capture, so per-address budgets do not leak between tests. */
  remoteAddress?: string;
  /** The phone's shutter time. Default: just now. */
  captureTimestamp?: number;
}

let captureAddress = 1;

export function playVerdict(requestHash: string, overrides: Partial<PlayIntegrityVerdict> = {}): AttestationPayload {
  const verdict: PlayIntegrityVerdict = {
    requestHash,
    requestPackageName: 'com.socialhuman.trustphoto',
    timestampMillis: Date.now(),
    appRecognitionVerdict: 'PLAY_RECOGNIZED',
    deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'],
    appAccessRiskVerdict: null,
    ...overrides,
  };
  return { type: 'play_integrity', token: JSON.stringify(verdict) };
}

/** Builds and sends one capture the way the phone does. */
export async function sendCapture(app: FastifyInstance, install: { installId: string; auth: Record<string, string> }, opts: CaptureOptions = {}) {
  const seed = opts.seed ?? Math.floor(Math.random() * 1e9);
  const takenAt = opts.captureTimestamp ?? Date.now() - 800;
  const photo = opts.photo ?? (await phonePhoto(seed, takenAt));
  const samples = opts.samples ?? motionTrace(seed, takenAt);
  const nonce = opts.nonce ?? (await getNonce(app, install.auth));
  const imageSha256 = sha256Hex(photo);
  const deviceInfo: CaptureBundle['deviceInfo'] = { platform: 'android', brand: 'google', model: 'Pixel 8', osVersion: '15', appVersion: '1.0.0', isDevice: true, hasGyroscope: true, ...opts.deviceInfo };
  const bindingHash = computeBindingHash({
    installId: install.installId,
    nonce,
    imageSha256,
    sensorDigest: computeSensorDigest(samples),
    deviceDigest: computeDeviceDigest(deviceInfo, takenAt),
  });
  const attestation =
    typeof opts.attestation === 'function' ? opts.attestation(bindingHash) : (opts.attestation ?? playVerdict(bindingHash));
  const bundle: CaptureBundle = {
    v: 1,
    nonce,
    imageSha256: opts.imageSha256 ?? imageSha256,
    captureTimestamp: takenAt,
    sensorData: samples,
    deviceInfo: opts.tamperDeviceInfo ? { ...deviceInfo, ...opts.tamperDeviceInfo } : deviceInfo,
    attestation,
  };
  const { payload, headers } = multipart(bundle, photo);
  const remoteAddress = opts.remoteAddress ?? `10.9.${Math.floor(captureAddress / 250)}.${(captureAddress++ % 250) + 1}`;
  const res = await app.inject({ method: 'POST', url: '/v1/captures', payload, headers: { ...headers, ...install.auth }, remoteAddress });
  return { res, photo, samples, bundle, bindingHash };
}
