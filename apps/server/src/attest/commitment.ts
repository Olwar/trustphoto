/**
 * Turns the phone's hardware commitment into one attestation verdict.
 * The rules:
 *
 *   pass          the commitment verified over exactly this binding hash
 *   fail          tampering evidence: a commitment over other bytes, a token
 *                 Google rejects, a cloned App Attest key
 *   inconclusive  no usable signal (development build, sideload, network,
 *                 server not configured)
 */

import type { AttestationPayload } from '@trustphoto/shared';
import { verifyBindingAssertion, type AppAttestConfig } from './app-attest.js';
import type { DecodeLane, PlayIntegrityDecoder } from './play-integrity.js';

export type AttestationVerdict = 'pass' | 'fail' | 'inconclusive';

export interface AttestationOutcome {
  verdict: AttestationVerdict;
  /** A hardware commitment over this capture verified. */
  bound: boolean;
  type: 'app_attest' | 'play_integrity' | null;
  /** Google answered for this capture and said the phone is not a certified Android device. */
  deviceNotCertified: boolean;
  /** Diagnostic reason, stored with the capture; never shown to users. */
  reason: string | null;
  /**
   * No answer because of us or Apple/Google (network, quota, config, a
   * retry race), not because of the phone. The capture is not stored as
   * final, so the same photo can be sent again.
   */
  transient: boolean;
  appAccessRisk: string[] | null;
}

export interface AppAttestKeyStore {
  /** The install's registered key, or null. */
  get(installId: string, keyId: string): Promise<{ publicKeyPem: string; signCount: number } | null>;
  /** Moves this key's counter forward only if it still holds `from`. False when another request (or a new key) won. */
  advance(installId: string, keyId: string, from: number, to: number): Promise<boolean>;
}

/** How old a Play Integrity verdict may be. */
export const VERDICT_MAX_AGE_MS = 10 * 60_000;

const outcome = (
  verdict: AttestationVerdict,
  type: AttestationOutcome['type'],
  reason: string | null,
  extra: Partial<AttestationOutcome> = {},
): AttestationOutcome => ({ verdict, bound: verdict === 'pass', type, deviceNotCertified: false, reason, appAccessRisk: null, transient: false, ...extra });

export async function verifyCommitment(args: {
  attestation: AttestationPayload;
  installId: string;
  bindingHash: string;
  appAttest: AppAttestConfig;
  keys: AppAttestKeyStore;
  decodePlayIntegrity: PlayIntegrityDecoder;
  /** Which budget of Google calls this install uses (see play-integrity.ts). */
  playLane?: DecodeLane;
  playPackageName: string | null;
  now?: number;
}): Promise<AttestationOutcome> {
  const { attestation, bindingHash } = args;
  const now = args.now ?? Date.now();

  switch (attestation.type) {
    case 'none':
      return outcome('inconclusive', null, `client: ${attestation.reason.slice(0, 64)}`);

    case 'play_integrity': {
      const decoded = await args.decodePlayIntegrity(attestation.token, args.playLane ?? 'unproven');
      if (!decoded.ok) {
        return decoded.reason === 'invalid'
          ? outcome('fail', 'play_integrity', 'decode_invalid')
          : outcome('inconclusive', 'play_integrity', `decode_${decoded.reason}`, { transient: true });
      }
      const v = decoded.verdict;
      const extra = { appAccessRisk: v.appAccessRiskVerdict };
      if (v.requestHash !== bindingHash) return outcome('fail', 'play_integrity', 'binding_mismatch', extra);
      if (args.playPackageName && v.requestPackageName && v.requestPackageName !== args.playPackageName) {
        return outcome('fail', 'play_integrity', 'package_mismatch', extra);
      }
      if (v.timestampMillis === null || now - v.timestampMillis > VERDICT_MAX_AGE_MS) {
        return outcome('fail', 'play_integrity', 'stale_verdict', extra);
      }
      if (!v.deviceRecognitionVerdict.includes('MEETS_DEVICE_INTEGRITY')) {
        return outcome('inconclusive', 'play_integrity', 'device_not_certified', { ...extra, deviceNotCertified: true });
      }
      if (v.appRecognitionVerdict !== 'PLAY_RECOGNIZED') {
        return outcome('inconclusive', 'play_integrity', 'app_not_recognized', extra);
      }
      return outcome('pass', 'play_integrity', null, extra);
    }

    case 'app_attest': {
      if (!args.appAttest.appId) return outcome('inconclusive', 'app_attest', 'misconfigured', { transient: true });
      const key = await args.keys.get(args.installId, attestation.keyId);
      // A key from an earlier install or another install: the phone re-runs registration.
      if (!key) return outcome('inconclusive', 'app_attest', 'unknown_key');
      const result = await verifyBindingAssertion(args.appAttest, key, attestation.assertion, bindingHash);
      if (!result.ok) {
        return result.reason === 'misconfigured'
          ? outcome('inconclusive', 'app_attest', result.reason, { transient: true })
          : outcome('fail', 'app_attest', result.reason);
      }
      // Two overlapping assertions verify against the same stored count; only
      // one may advance it. The loser is a retry race, not cloning evidence.
      if (!(await args.keys.advance(args.installId, attestation.keyId, key.signCount, result.signCount))) {
        return outcome('inconclusive', 'app_attest', 'concurrent_update', { transient: true });
      }
      return outcome('pass', 'app_attest', null);
    }
    default:
      return outcome('inconclusive', null, 'unknown_commitment_type');
  }
}
