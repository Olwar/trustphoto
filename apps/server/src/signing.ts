/**
 * Signed receipts. Each proof carries an Ed25519 signature over a canonical
 * JSON receipt, and the public key is published at
 * /.well-known/trustphoto-keys.json, so anyone can check a receipt without
 * trusting this server's pages.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface Signer {
  keyId: string;
  publicJwk: JsonWebKey;
  /** The current key first, then retired keys, so receipts signed before a key change still check. */
  publishedJwks: JsonWebKey[];
  sign(receipt: object): string;
}

/** JSON with object keys sorted at every level: the bytes that get signed. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function jwkOf(publicKey: KeyObject): { keyId: string; jwk: JsonWebKey } {
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const keyId = createHash('sha256').update(spki).digest('hex').slice(0, 16);
  return { keyId, jwk: { ...publicKey.export({ format: 'jwk' }), kid: keyId, alg: 'EdDSA', use: 'sig' } as JsonWebKey };
}

export function createSigner(privateKey: KeyObject, retiredPublicPems: string[] = []): Signer {
  const publicKey = createPublicKey(privateKey);
  const { keyId, jwk } = jwkOf(publicKey);
  return {
    keyId,
    publicJwk: jwk,
    publishedJwks: [jwk, ...retiredPublicPems.map((pem) => jwkOf(createPublicKey(pem)).jwk)],
    sign: (receipt) => sign(null, Buffer.from(canonicalJson(receipt)), privateKey).toString('base64url'),
  };
}

/**
 * The key comes from TRUSTPHOTO_SIGNING_KEY (PKCS#8 PEM) in production.
 * In development a key is made once and kept in the data folder.
 */
export async function loadSigner(opts: { pem: string | null; devKeyPath: string | null; retiredPublicPems?: string[] }): Promise<Signer> {
  if (opts.pem) return createSigner(createPrivateKey(opts.pem), opts.retiredPublicPems);
  if (!opts.devKeyPath) return createSigner(generateKeyPairSync('ed25519').privateKey);
  try {
    return createSigner(createPrivateKey(await readFile(opts.devKeyPath, 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const { privateKey } = generateKeyPairSync('ed25519');
    await mkdir(dirname(opts.devKeyPath), { recursive: true });
    await writeFile(opts.devKeyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    return createSigner(privateKey);
  }
}
