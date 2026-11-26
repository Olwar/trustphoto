import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Unguessable public photo ID: 12 base62 characters, about 71 bits. */
export function newPhotoId(length = 12): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      // 248 = 4 * 62: reject the top bytes so every character is equally likely.
      if (byte < 248 && out.length < length) out += BASE62[byte % 62];
    }
  }
  return out;
}

export const isPhotoId = (value: string) => /^[0-9A-Za-z]{12}$/.test(value);

export function newInstallToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacHex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

const tokenKey = (secret: string) => createHash('sha256').update(`lookup-token:${secret}`).digest();

/**
 * Names one photo for the confirm step of a lookup without showing its ID:
 * the ID and an expiry time, encrypted and authenticated (AES-256-GCM).
 */
export function sealLookupToken(secret: string, photoId: string, expiresAt: number): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', tokenKey(secret), iv);
  const body = Buffer.concat([cipher.update(`${photoId}.${expiresAt}`, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** The photo ID of a token made by `sealLookupToken`, or null (changed, made with another secret, or expired). */
export function openLookupToken(secret: string, token: string, now: number): string | null {
  try {
    const raw = Buffer.from(token, 'base64url');
    if (raw.length < 12 + 16 + 14) return null;
    const decipher = createDecipheriv('aes-256-gcm', tokenKey(secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const [photoId, expiresAt] = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8').split('.');
    return isPhotoId(photoId) && Number(expiresAt) > now ? photoId : null;
  } catch {
    return null;
  }
}
