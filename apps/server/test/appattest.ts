import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { encode } from 'cborg';

/**
 * A software stand-in for a Secure Enclave App Attest key: builds assertions
 * exactly as Apple's format defines them (CBOR { signature, authenticatorData },
 * ECDSA P-256 over SHA256(authenticatorData || SHA256(clientData))), so the
 * real verifier runs end to end. The one-time Apple attestation cannot be
 * built without Apple's CA, so tests store the public key directly.
 */
export function makeAppAttestKey(appId: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const rpIdHash = createHash('sha256').update(appId).digest();
  return {
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    assert(clientData: string, signCount: number): string {
      const counter = Buffer.alloc(4);
      counter.writeUInt32BE(signCount);
      const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([0x40]), counter]);
      const clientDataHash = createHash('sha256').update(clientData).digest();
      const nonce = createHash('sha256').update(Buffer.concat([authenticatorData, clientDataHash])).digest();
      const signature = sign('sha256', nonce, privateKey);
      return Buffer.from(encode({ signature, authenticatorData })).toString('base64');
    },
  };
}
