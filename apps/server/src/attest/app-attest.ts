/**
 * Apple App Attest (iOS).
 *
 * Once per install: the phone makes a Secure Enclave key, Apple attests it,
 * and verifyKeyAttestation() checks the attestation (certificate chain to
 * Apple's App Attest root) and returns the key's public key.
 *
 * Per capture: the phone signs the binding hash with that key, and
 * verifyAssertion() checks the signature and that the sign counter moved
 * forward. A counter that did not move forward is evidence of a cloned key.
 */

import { verifyAttestation } from '@bradford-tech/supabase-integrity-attest/attestation';
import { AssertionError, AssertionErrorCode, verifyAssertion } from '@bradford-tech/supabase-integrity-attest/assertion';
import { createHash } from 'node:crypto';

export interface AppAttestConfig {
  /** `<TeamID>.<bundle id>`. Unset: App Attest is off and iOS captures are inconclusive. */
  appId: string | null;
  /** Development builds attest against Apple's development environment. */
  development: boolean;
}

export type KeyAttestationOutcome =
  | { ok: true; publicKeyPem: string; signCount: number }
  | { ok: false; reason: 'invalid_attestation' | 'misconfigured'; error: string };

export async function verifyKeyAttestation(
  cfg: AppAttestConfig,
  keyId: string,
  challenge: string,
  attestationBase64: string,
): Promise<KeyAttestationOutcome> {
  if (!cfg.appId) return { ok: false, reason: 'misconfigured', error: 'APP_ATTEST_APP_ID is not set' };
  try {
    // The phone SDK hashes the UTF-8 challenge into clientDataHash itself.
    const clientDataHash = new Uint8Array(createHash('sha256').update(challenge, 'utf8').digest());
    const { publicKeyPem, signCount } = await verifyAttestation(
      { appId: cfg.appId, developmentEnv: cfg.development },
      keyId,
      clientDataHash,
      Buffer.from(attestationBase64, 'base64'),
    );
    return { ok: true, publicKeyPem, signCount };
  } catch (err) {
    return { ok: false, reason: 'invalid_attestation', error: err instanceof Error ? err.message : String(err) };
  }
}

export type AssertionOutcome =
  | { ok: true; signCount: number }
  | { ok: false; reason: 'invalid_assertion' | 'counter_regression' | 'misconfigured'; error: string };

/** `clientData` must be byte-identical to what the phone signed: the binding hash string. */
export async function verifyBindingAssertion(
  cfg: AppAttestConfig,
  key: { publicKeyPem: string; signCount: number },
  assertionBase64: string,
  clientData: string,
): Promise<AssertionOutcome> {
  if (!cfg.appId) return { ok: false, reason: 'misconfigured', error: 'APP_ATTEST_APP_ID is not set' };
  try {
    const { signCount } = await verifyAssertion(
      { appId: cfg.appId },
      Buffer.from(assertionBase64, 'base64'),
      new TextEncoder().encode(clientData),
      key.publicKeyPem,
      key.signCount,
    );
    return { ok: true, signCount };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (err instanceof AssertionError && err.code === AssertionErrorCode.COUNTER_NOT_INCREMENTED) {
      return { ok: false, reason: 'counter_regression', error };
    }
    return { ok: false, reason: 'invalid_assertion', error };
  }
}
