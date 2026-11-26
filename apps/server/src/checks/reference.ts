/**
 * The reference photo checks: a small example of the `PhotoChecks`
 * interface. They are honest about what they are: three simple tests that a
 * careful person can pass with a fake. They are here so that the project
 * runs, the tests run, and a fork has a place to start. They are NOT the
 * checks of the TrustPhoto service (see docs/PHOTO-CHECKS.md).
 *
 * What they test:
 * 1. Motion: the trace is long enough, and the accelerometer shows gravity
 *    (about 1 g), as a phone in a hand does.
 * 2. Camera file: the JPEG carries the camera make and model in its EXIF.
 *    That is no test for editing, so the proof page never shows "No sign of
 *    editing" as passed with these checks.
 * 3. Screen (optional): a vision model is not sure that the photo shows a
 *    screen. Off unless VISION_CHECK_URL and VISION_CHECK_API_KEY are set.
 *    Only a sure "not a screen" lets the proof page say "No screen found".
 */

import exifr from 'exifr';
import type { PublicCheck, SensorSample } from '@trustphoto/shared';
import type { PhotoAnalysis, PhotoChecks, ScreenCheckResult } from './types.js';

/** About half a second of samples at the app's sensor rate. */
const MIN_SAMPLES = 30;
/** A phone at rest or in a hand measures about 1 g. */
const GRAVITY_MIN = 0.7;
const GRAVITY_MAX = 1.3;
/** A vision answer counts from this confidence up. */
const VISION_CONFIDENCE = 0.6;

const VISION_PROMPT =
  'Is the main subject of this photo an electronic screen (a monitor, laptop, phone, tablet or TV) that shows other content? ' +
  'Answer with only a JSON object: {"screen": true|false, "confidence": <number from 0 to 1>, "reason": "<one short sentence>"}.';

interface ReferenceAnalysis extends PhotoAnalysis {
  motion: { ok: boolean; samples: number; meanGravity: number | null };
  cameraFile: { ok: boolean; make: string | null; model: string | null };
}

export interface VisionConfig {
  /** An OpenAI-compatible chat completions URL. */
  url: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** The name the privacy page shows for the company behind `url`. */
  provider: string;
}

export function visionConfigFromEnv(env: NodeJS.ProcessEnv): VisionConfig | null {
  const url = env.VISION_CHECK_URL?.trim();
  const apiKey = env.VISION_CHECK_API_KEY?.trim();
  if (!url || !apiKey) return null;
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('not http');
    host = parsed.hostname;
  } catch {
    throw new Error('VISION_CHECK_URL is not a valid http(s) address');
  }
  const timeout = Number(env.VISION_CHECK_TIMEOUT_MS);
  return {
    url,
    apiKey,
    model: env.VISION_CHECK_MODEL?.trim() || 'gpt-4o-mini',
    // AbortSignal.timeout takes whole milliseconds.
    timeoutMs: Number.isFinite(timeout) && timeout >= 1 ? Math.round(timeout) : 8000,
    provider: env.VISION_CHECK_PROVIDER?.trim() || host,
  };
}

function checkMotion(samples: SensorSample[]): ReferenceAnalysis['motion'] {
  if (samples.length === 0) return { ok: false, samples: 0, meanGravity: null };
  const sum = samples.reduce((total, s) => total + Math.hypot(s.accelerometer.x, s.accelerometer.y, s.accelerometer.z), 0);
  const meanGravity = sum / samples.length;
  return { ok: samples.length >= MIN_SAMPLES && meanGravity >= GRAVITY_MIN && meanGravity <= GRAVITY_MAX, samples: samples.length, meanGravity };
}

async function checkCameraFile(image: Buffer): Promise<ReferenceAnalysis['cameraFile']> {
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 60) : null);
  try {
    const exif = (await exifr.parse(image, { pick: ['Make', 'Model'] })) as { Make?: unknown; Model?: unknown } | undefined;
    const make = text(exif?.Make);
    const model = text(exif?.Model);
    return { ok: make !== null && model !== null, make, model };
  } catch {
    return { ok: false, make: null, model: null };
  }
}

export function parseVisionAnswer(text: string): { screen: boolean; confidence: number; reason: string | null } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { screen?: unknown; confidence?: unknown; reason?: unknown };
    if (typeof parsed.screen !== 'boolean' || typeof parsed.confidence !== 'number') return null;
    // A confidence outside 0..1 is a broken answer. It is never clamped into a sure one.
    if (!(parsed.confidence >= 0 && parsed.confidence <= 1)) return null;
    return { screen: parsed.screen, confidence: parsed.confidence, reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 300) : null };
  } catch {
    return null;
  }
}

async function askVision(cfg: VisionConfig | null, imageUrl: string, fetchImpl: typeof fetch): Promise<ScreenCheckResult> {
  const model = cfg?.model ?? 'none';
  const fail = (error: NonNullable<ScreenCheckResult['error']>): ScreenCheckResult => ({ screen: null, confidence: null, reason: null, model, error });
  if (!cfg) return fail('not_configured');
  let response: Response;
  try {
    response = await fetchImpl(cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 200,
        messages: [{ role: 'user', content: [{ type: 'text', text: VISION_PROMPT }, { type: 'image_url', image_url: { url: imageUrl } }] }],
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    return fail(err instanceof DOMException && err.name === 'TimeoutError' ? 'timeout' : 'fetch_failed');
  }
  if (!response.ok) return fail(`http_${response.status}`);
  let content: unknown;
  try {
    content = ((await response.json()) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
  } catch {
    return fail('unparseable_response');
  }
  if (typeof content !== 'string' || content.length === 0) return fail('no_content');
  const answer = parseVisionAnswer(content);
  return answer ? { ...answer, model } : fail('verdict_parse_failed');
}

export function createReferenceChecks(opts: { vision?: VisionConfig | null; allowInProduction?: boolean; fetch?: typeof fetch } = {}): PhotoChecks {
  const vision = opts.vision ?? null;
  return {
    name: 'reference',
    visionProvider: vision?.provider ?? null,

    productionProblems() {
      return opts.allowInProduction
        ? []
        : [
            'The reference photo checks are an example, and a careful fake passes them. Load your own module (docs/PHOTO-CHECKS.md), or set PHOTO_CHECKS_MODULE=reference and ALLOW_REFERENCE_CHECKS=true to run them in production anyway.',
          ];
    },

    warnings() {
      return [
        'The reference photo checks are active. They are an example, and a careful fake passes them (docs/PHOTO-CHECKS.md).',
        ...(vision ? [] : ['VISION_CHECK_URL and VISION_CHECK_API_KEY are not set: no photo gets a screen check.']),
      ];
    },

    // The app reports a simulator or an emulator itself. A modified app that lies here fails the device check.
    looksEmulated: (_samples, deviceInfo) => !deviceInfo.isDevice,

    motionFingerprint: () => null,

    async analyze(input) {
      const motion = checkMotion(input.sensorSamples);
      const cameraFile = await checkCameraFile(input.imageBuffer);
      const passed = motion.ok && cameraFile.ok;
      const analysis: ReferenceAnalysis = {
        passed,
        score: (Number(motion.ok) + Number(cameraFile.ok)) / 2,
        record: { checks: 'reference', motion, cameraFile },
        motion,
        cameraFile,
      };
      return analysis;
    },

    askScreen: (imageUrl) => askVision(vision, imageUrl, opts.fetch ?? fetch),

    decideScreen(answer) {
      if (answer.error === 'not_configured') return { cleared: false, flagged: false, failed: false };
      if (answer.error || answer.screen === null || answer.confidence === null) return { cleared: false, flagged: false, failed: true };
      const sure = answer.confidence >= VISION_CONFIDENCE;
      return { cleared: sure && !answer.screen, flagged: sure && answer.screen, failed: false };
    },

    decide({ analysis, attestation, requireAttestation, screen }) {
      const a = analysis as ReferenceAnalysis;
      if (attestation.verdict === 'fail' || attestation.deviceNotCertified) {
        return { status: 'rejected', reason: 'device', detail: `attestation ${attestation.verdict}: ${attestation.reason ?? ''}` };
      }
      if (requireAttestation && !attestation.bound) {
        return { status: 'not_verified', reason: 'device', detail: `attestation required, got ${attestation.verdict}` };
      }
      if (!a.motion.ok) return { status: 'not_verified', reason: 'motion', detail: `motion: ${a.motion.samples} samples, mean ${a.motion.meanGravity?.toFixed(2) ?? 'none'} g` };
      if (!a.cameraFile.ok) return { status: 'not_verified', reason: 'checks', detail: 'camera file: no make or model in the EXIF data' };
      if (screen.flagged) return { status: 'not_verified', reason: 'screen', detail: 'vision check: screen' };
      return { status: 'verified' };
    },

    publicChecks(analysis, attestation, screen) {
      const a = analysis as ReferenceAnalysis;
      const entries: [PublicCheck['key'], boolean][] = [
        ['device', attestation.bound],
        ['motion', a.motion.ok],
        ['screen', screen.cleared],
        // A make and a model in the EXIF say nothing about editing: never claim "No sign of editing".
        ['camera_file', false],
      ];
      return entries.map(([key, ok]) => ({ key, state: ok ? 'passed' : 'inconclusive' }));
    },
  };
}
