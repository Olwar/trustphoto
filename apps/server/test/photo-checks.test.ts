/**
 * The reference photo checks and the loader that picks the checks at start.
 * These tests name the reference module directly, so they run the same with
 * or without a private module in apps/server/private/.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { AttestationOutcome } from '../src/attest/commitment.js';
import { assertFitForProduction, loadPhotoChecks } from '../src/checks/load.js';
import { createHarness } from './harness.js';
import { createReferenceChecks, parseVisionAnswer, visionConfigFromEnv, type VisionConfig } from '../src/checks/reference.js';
import type { PhotoCheckInput, ScreenDecision } from '../src/checks/types.js';
import { motionTrace, phonePhoto } from './fixtures.js';

/** Without a private module, or with PHOTO_CHECKS_MODULE=reference, the test server runs the reference checks. */
const referenceOnly = process.env.PHOTO_CHECKS_MODULE === 'reference' || !existsSync(resolve(import.meta.dirname, '../private/photo-checks'));

const bound: AttestationOutcome = { verdict: 'pass', bound: true, type: 'play_integrity', deviceNotCertified: false, reason: null, appAccessRisk: null, transient: false };
const noScreenAnswer: ScreenDecision = { cleared: false, flagged: false, failed: false };
const deviceInfo = { platform: 'android' as const, brand: 'google', model: 'Pixel 8', osVersion: '15', appVersion: '1.0.0', isDevice: true, hasGyroscope: true };

async function input(overrides: Partial<PhotoCheckInput> = {}): Promise<PhotoCheckInput> {
  const now = Date.now();
  return { imageBuffer: await phonePhoto(3, now), sensorSamples: motionTrace(3, now), deviceInfo, captureTimestamp: now, receivedAt: now, attestation: bound, ...overrides };
}

describe('the reference checks', () => {
  const checks = createReferenceChecks();

  it('pass a camera photo with a motion trace of a phone held still', async () => {
    const analysis = await checks.analyze(await input());
    expect(analysis.passed).toBe(true);
    expect(checks.decide({ analysis, attestation: bound, requireAttestation: true, screen: noScreenAnswer })).toEqual({ status: 'verified' });
    expect(checks.publicChecks(analysis, bound, noScreenAnswer)).toEqual([
      { key: 'device', state: 'passed' },
      { key: 'motion', state: 'passed' },
      // No vision answer: the proof page must not say "No screen found".
      { key: 'screen', state: 'inconclusive' },
      // The reference checks read only the make and the model: they never claim "No sign of editing".
      { key: 'camera_file', state: 'inconclusive' },
    ]);
  });

  it('do not pass a short motion trace, or one that shows no gravity', async () => {
    const short = await checks.analyze(await input({ sensorSamples: motionTrace(4, Date.now(), 5) }));
    expect(checks.decide({ analysis: short, attestation: bound, requireAttestation: true, screen: noScreenAnswer })).toMatchObject({ status: 'not_verified', reason: 'motion' });

    const weightless = motionTrace(5, Date.now()).map((s) => ({ ...s, accelerometer: { x: 0, y: 0, z: 0 } }));
    const floating = await checks.analyze(await input({ sensorSamples: weightless }));
    expect(floating.passed).toBe(false);
    expect(checks.decide({ analysis: floating, attestation: bound, requireAttestation: true, screen: noScreenAnswer })).toMatchObject({ reason: 'motion' });
  });

  it('do not pass a JPEG with no camera make and model', async () => {
    const plain = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#888' } }).jpeg().toBuffer();
    const analysis = await checks.analyze(await input({ imageBuffer: plain }));
    expect(analysis.passed).toBe(false);
    expect(checks.decide({ analysis, attestation: bound, requireAttestation: true, screen: noScreenAnswer })).toMatchObject({ status: 'not_verified', reason: 'checks' });
  });

  it('never verify without a bound device check when one is required, and reject a failed one', async () => {
    const analysis = await checks.analyze(await input());
    const unbound = { ...bound, verdict: 'inconclusive' as const, bound: false };
    expect(checks.decide({ analysis, attestation: unbound, requireAttestation: true, screen: noScreenAnswer })).toMatchObject({ status: 'not_verified', reason: 'device' });
    expect(checks.decide({ analysis, attestation: unbound, requireAttestation: false, screen: noScreenAnswer })).toEqual({ status: 'verified' });
    expect(checks.decide({ analysis, attestation: { ...unbound, verdict: 'fail' }, requireAttestation: false, screen: noScreenAnswer })).toMatchObject({ status: 'rejected', reason: 'device' });
  });

  it('hold a photo on a sure "screen", and say "No screen found" only after a sure "not a screen"', async () => {
    const analysis = await checks.analyze(await input());
    const flagged = { cleared: false, flagged: true, failed: false };
    const cleared = { cleared: true, flagged: false, failed: false };
    expect(checks.decide({ analysis, attestation: bound, requireAttestation: true, screen: flagged })).toMatchObject({ status: 'not_verified', reason: 'screen' });
    expect(checks.decide({ analysis, attestation: bound, requireAttestation: true, screen: cleared })).toEqual({ status: 'verified' });
    expect(checks.publicChecks(analysis, bound, cleared).find((c) => c.key === 'screen')).toEqual({ key: 'screen', state: 'passed' });
  });

  it('call a trace emulated only when the app says it runs on no real device', () => {
    const samples = motionTrace(6, Date.now());
    expect(checks.looksEmulated(samples, deviceInfo)).toBe(false);
    expect(checks.looksEmulated(samples, { ...deviceInfo, isDevice: false })).toBe(true);
    expect(checks.motionFingerprint(samples)).toBeNull();
  });

  it('refuse to run in production unless the operator allows them', () => {
    expect(checks.productionProblems()).toHaveLength(1);
    expect(createReferenceChecks({ allowInProduction: true }).productionProblems()).toEqual([]);
    expect(checks.warnings().join(' ')).toContain('example');
  });
});

describe('the reference vision check', () => {
  const vision: VisionConfig = { url: 'https://vision.example/v1/chat/completions', apiKey: 'test-key', model: 'test-model', timeoutMs: 1000, provider: 'Example Vision' };
  const answering = (content: unknown, status = 200) =>
    (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status })) as unknown as typeof fetch;

  it('is off without settings: it asks nobody and decides nothing', async () => {
    const checks = createReferenceChecks();
    expect(checks.visionProvider).toBeNull();
    const answer = await checks.askScreen('https://trustphoto.test/v1/pending/x.jpg');
    expect(answer.error).toBe('not_configured');
    expect(checks.decideScreen(answer)).toEqual(noScreenAnswer);
  });

  it('sends the image address and the key, and reads the answer', async () => {
    let request: { url: string; init: RequestInit } | null = null;
    const checks = createReferenceChecks({
      vision,
      fetch: (async (url: string, init: RequestInit) => {
        request = { url, init };
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"screen": true, "confidence": 0.9, "reason": "a monitor"}' } }] }));
      }) as unknown as typeof fetch,
    });
    const answer = await checks.askScreen('https://trustphoto.test/v1/pending/x.jpg');
    expect(answer).toEqual({ screen: true, confidence: 0.9, reason: 'a monitor', model: 'test-model' });
    expect(request!.url).toBe(vision.url);
    expect((request!.init.headers as Record<string, string>).authorization).toBe('Bearer test-key');
    expect(String(request!.init.body)).toContain('https://trustphoto.test/v1/pending/x.jpg');
    expect(checks.visionProvider).toBe('Example Vision');
  });

  it('holds a photo only on a sure "screen", and clears only on a sure "not a screen"', () => {
    const checks = createReferenceChecks({ vision });
    const answer = (screen: boolean, confidence: number) => ({ screen, confidence, reason: null, model: 'm' });
    expect(checks.decideScreen(answer(true, 0.9))).toEqual({ cleared: false, flagged: true, failed: false });
    expect(checks.decideScreen(answer(true, 0.3))).toEqual(noScreenAnswer);
    expect(checks.decideScreen(answer(false, 0.9))).toEqual({ cleared: true, flagged: false, failed: false });
    expect(checks.decideScreen(answer(false, 0.3))).toEqual(noScreenAnswer);
  });

  it('reports an outage as failed, so nothing is stored and the phone may try again', async () => {
    const failed = { cleared: false, flagged: false, failed: true };
    const down = createReferenceChecks({ vision, fetch: answering('', 503) });
    expect(down.decideScreen(await down.askScreen('https://x.test/a.jpg'))).toEqual(failed);
    const nonsense = createReferenceChecks({ vision, fetch: answering('I cannot help with that.') });
    const answer = await nonsense.askScreen('https://x.test/a.jpg');
    expect(answer.error).toBe('verdict_parse_failed');
    expect(nonsense.decideScreen(answer)).toEqual(failed);
    const unreachable = createReferenceChecks({ vision, fetch: (async () => Promise.reject(new Error('no route'))) as unknown as typeof fetch });
    expect((await unreachable.askScreen('https://x.test/a.jpg')).error).toBe('fetch_failed');
  });

  it('reads only an answer inside the contract', () => {
    expect(parseVisionAnswer('```json\n{"screen": false, "confidence": 0.8, "reason": "a street"}\n```')).toEqual({ screen: false, confidence: 0.8, reason: 'a street' });
    expect(parseVisionAnswer('{"screen": true, "confidence": 85}')).toBeNull();
    expect(parseVisionAnswer('{"screen": "yes", "confidence": 0.9}')).toBeNull();
    expect(parseVisionAnswer('no JSON here')).toBeNull();
  });

  it('reads its settings from the environment, and names the provider by its host when no name is set', () => {
    expect(visionConfigFromEnv({})).toBeNull();
    expect(visionConfigFromEnv({ VISION_CHECK_URL: 'https://vision.example/v1/chat/completions' })).toBeNull();
    const cfg = visionConfigFromEnv({ VISION_CHECK_URL: 'https://vision.example/v1/chat/completions', VISION_CHECK_API_KEY: 'k' });
    expect(cfg).toMatchObject({ provider: 'vision.example', timeoutMs: 8000 });
    const timeout = (v: string) => visionConfigFromEnv({ VISION_CHECK_URL: 'https://vision.example/v1', VISION_CHECK_API_KEY: 'k', VISION_CHECK_TIMEOUT_MS: v })?.timeoutMs;
    expect(timeout('1500.5')).toBe(1501);
    expect(timeout('0.2')).toBe(8000);
    expect(visionConfigFromEnv({ VISION_CHECK_URL: 'https://vision.example/v1', VISION_CHECK_API_KEY: 'k', VISION_CHECK_PROVIDER: 'Example AI, in the EU' })?.provider).toBe('Example AI, in the EU');
    expect(() => visionConfigFromEnv({ VISION_CHECK_URL: 'vision.example/v1', VISION_CHECK_API_KEY: 'k', VISION_CHECK_PROVIDER: 'X' })).toThrow(/VISION_CHECK_URL/);
  });
});

describe('the loader', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'trustphoto-checks-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('gives the reference checks when asked for them by name', async () => {
    const checks = await loadPhotoChecks({ PHOTO_CHECKS_MODULE: 'reference' });
    expect(checks.name).toBe('reference');
    expect(checks.productionProblems()).toHaveLength(1);
    expect((await loadPhotoChecks({ PHOTO_CHECKS_MODULE: 'reference', ALLOW_REFERENCE_CHECKS: 'true' })).productionProblems()).toEqual([]);
    expect((await loadPhotoChecks({ PHOTO_CHECKS_MODULE: 'reference', ALLOW_REFERENCE_CHECKS: '1' })).productionProblems()).toEqual([]);
  });

  it('refuses a production start with checks that are not fit for it, and allows the reference checks only by name', async () => {
    await expect(loadPhotoChecks({ PHOTO_CHECKS_MODULE: 'reference' }, { production: true })).rejects.toThrow(/cannot run in production/);
    await expect(loadPhotoChecks({ PHOTO_CHECKS_MODULE: 'reference', ALLOW_REFERENCE_CHECKS: 'true' }, { production: true })).resolves.toMatchObject({ name: 'reference' });
  });

  it.runIf(!existsSync(resolve(import.meta.dirname, '../private/photo-checks')))('does not let the permission reach the automatic fallback to the reference checks', async () => {
    const fallback = await loadPhotoChecks({ ALLOW_REFERENCE_CHECKS: 'true' });
    expect(fallback.name).toBe('reference');
    await expect(loadPhotoChecks({ ALLOW_REFERENCE_CHECKS: 'true' }, { production: true })).rejects.toThrow(/cannot run in production/);
  });

  it('stops a production start with the reference checks, unless the operator allowed them', async () => {
    expect(() => assertFitForProduction(createReferenceChecks())).toThrow(/cannot run in production/);
    expect(() => assertFitForProduction(createReferenceChecks({ allowInProduction: true }))).not.toThrow();
  });

  it('loads a module from a path, with the environment', async () => {
    const file = join(dir, 'my-checks.mjs');
    await writeFile(
      file,
      `export function createPhotoChecks(env) {
        return {
          name: 'mine-' + env.MY_SETTING, visionProvider: null,
          warnings: () => [], productionProblems: () => [],
          looksEmulated: () => false, motionFingerprint: () => null,
          analyze: async () => ({ passed: true, score: 1, record: {} }),
          askScreen: async () => ({ screen: null, confidence: null, reason: null, model: 'none', error: 'not_configured' }),
          decideScreen: () => ({ cleared: false, flagged: false, failed: false }),
          decide: () => ({ status: 'verified' }), publicChecks: () => [],
        };
      }`,
    );
    expect((await loadPhotoChecks({ PHOTO_CHECKS_MODULE: file, MY_SETTING: 'a' })).name).toBe('mine-a');
  });

  it('refuses a module that does not have the whole interface, and one that does not exist', async () => {
    const file = join(dir, 'half.mjs');
    await writeFile(file, `export const photoChecks = { name: 'half', warnings: () => [] };`);
    await expect(loadPhotoChecks({ PHOTO_CHECKS_MODULE: file })).rejects.toThrow(/analyze/);
    const nulls = join(dir, 'nulls.mjs');
    await writeFile(nulls, `export const photoChecks = { name: 'n', visionProvider: null, warnings: () => [], productionProblems: () => [], looksEmulated: () => false, motionFingerprint: () => null, analyze: null, askScreen: () => null, decideScreen: () => null, decide: () => null, publicChecks: () => [] };`);
    await expect(loadPhotoChecks({ PHOTO_CHECKS_MODULE: nulls })).rejects.toThrow(/analyze/);
    await expect(loadPhotoChecks({ PHOTO_CHECKS_MODULE: join(dir, 'missing.mjs') })).rejects.toThrow(/Could not load the photo checks module/);
  });
});

describe('the checks the test server runs', () => {
  it.runIf(referenceOnly)('are the reference checks without a private module, or when the tests ask for them', async () => {
    const h = await createHarness();
    try {
      expect(h.ctx.checks.name).toBe('reference');
    } finally {
      await h.close();
    }
  });
});
