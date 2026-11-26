/**
 * The photo checks: the part of the verification that looks at the photo
 * and its motion trace and says "this looks like a direct camera photo".
 *
 * Everything else that makes a proof is in this repository and does not
 * depend on secrecy: the device check (App Attest / Play Integrity), the
 * binding hash, the single-use nonce, the replay fences and the signed
 * receipt. The photo checks are different. They are tuned rules, and tuned
 * rules get weaker when the person who wants to pass them can test against
 * them offline. So they sit behind this interface:
 *
 * - `reference.ts` is a small, readable example. Development, the tests and
 *   a fork use it.
 * - The TrustPhoto service loads its own private module instead (see
 *   `load.ts` and docs/PHOTO-CHECKS.md).
 */

import type { DeviceInfo, NotVerifiedReason, PublicCheck, SensorSample } from '@trustphoto/shared';
import type { AttestationOutcome } from '../attest/commitment.js';

export interface PhotoCheckInput {
  /** The JPEG exactly as the phone sent it (its SHA-256 is bound into the device check). */
  imageBuffer: Buffer;
  /** The motion trace around the shot (bound into the device check). */
  sensorSamples: SensorSample[];
  /** Phone details as the app reported them (bound into the device check). */
  deviceInfo: DeviceInfo;
  /** Phone-reported shutter time (ms). */
  captureTimestamp: number;
  /** Server receive time (ms). */
  receivedAt: number;
  /**
   * What the device check found. `appAccessRisk` is Google's list of other
   * apps that could capture or control the screen (Play Integrity only), for
   * a module that wants to weigh it; the reference checks do not.
   */
  attestation: AttestationOutcome;
}

export interface PhotoAnalysis {
  /**
   * The checks alone would let this photo verify. Only then does the server
   * make the temporary copy and ask the vision check, which has the last word.
   */
  passed: boolean;
  /** 0..1, stored in `captures.score` for the operator. */
  score: number | null;
  /**
   * Stored in `captures.result` for the operator: numbers and short notes
   * only, never the photo or the motion trace.
   */
  record: Record<string, unknown>;
}

/** One answer of the vision check to "is this a photo of a screen?". */
export interface ScreenCheckResult {
  screen: boolean | null;
  confidence: number | null;
  reason: string | null;
  model: string;
  /** Set when no usable answer came back. */
  error?: 'not_configured' | 'timeout' | 'fetch_failed' | 'no_content' | 'unparseable_response' | 'verdict_parse_failed' | `http_${number}`;
}

export interface ScreenDecision {
  /** A confident "not a screen". */
  cleared: boolean;
  /** A confident "screen": the photo does not verify. */
  flagged: boolean;
  /**
   * The check is configured but gave no usable answer. There is no person
   * who reviews later, so the server stores nothing and the phone may send
   * the same photo again.
   */
  failed: boolean;
}

export type Decision =
  | { status: 'verified' }
  | { status: 'not_verified' | 'rejected'; reason: NotVerifiedReason; detail: string };

export interface PhotoChecks {
  /** Shown in the start log. `reference` is the example in this repository. */
  readonly name: string;
  /** Things the operator should know at start, for example a missing key. */
  warnings(): string[];
  /**
   * Why this module must not run in production as it is configured (empty:
   * it may). The server refuses to start in production while this has entries.
   */
  productionProblems(): string[];
  /**
   * Who gets a copy of a would-pass photo for the vision check, as the
   * privacy page names it ("Example AI, in the EU"). Null with no vision check.
   */
  readonly visionProvider: string | null;

  /** Upload time, before anything is spent: does this motion trace come from an emulator? */
  looksEmulated(samples: SensorSample[], deviceInfo: DeviceInfo): boolean;
  /**
   * A short fingerprint that stays the same for a lightly changed copy of a
   * motion trace, or null for none. The server refuses the same fingerprint
   * twice from one install within 30 days. The exact trace is fenced for
   * everyone by the server itself (`sensor_digest`).
   */
  motionFingerprint(samples: SensorSample[]): string | null;

  /** Looks at the photo and the motion trace. Decodes the full photo, so the server runs it in a bounded slot. */
  analyze(input: PhotoCheckInput): Promise<PhotoAnalysis>;

  /** Asks the vision model about a copy of the photo with no metadata. `imageUrl` is valid for two minutes. */
  askScreen(imageUrl: string): Promise<ScreenCheckResult>;
  /** What one vision answer means. */
  decideScreen(answer: ScreenCheckResult): ScreenDecision;

  /** The final answer for one capture. `analysis` is the object this module's `analyze` returned. */
  decide(args: { analysis: PhotoAnalysis; attestation: AttestationOutcome; requireAttestation: boolean; screen: ScreenDecision }): Decision;
  /** The four facts a proof page shows, for a verified photo. */
  publicChecks(analysis: PhotoAnalysis, attestation: AttestationOutcome, screen: ScreenDecision): PublicCheck[];
}
