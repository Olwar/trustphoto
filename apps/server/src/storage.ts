import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/** Where photo files live. Local disk in development, any S3-compatible bucket (Cloudflare R2) in production. */
export interface Storage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** null when the object does not exist. */
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

export function localStorage(root: string): Storage {
  const base = resolve(root);
  const pathFor = (key: string) => {
    const full = resolve(base, key);
    if (!full.startsWith(base + sep)) throw new Error('storage key escapes the root');
    return full;
  };
  return {
    async put(key, body) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    },
    async get(key) {
      try {
        return await readFile(pathFor(key));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    async delete(key) {
      await rm(pathFor(key), { force: true });
    },
  };
}

export async function s3Storage(opts: {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  /** MinIO and most self-hosted S3 servers need path-style URLs (S3_FORCE_PATH_STYLE=true). */
  forcePathStyle?: boolean;
}): Promise<Storage> {
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, NoSuchKey } = await import('@aws-sdk/client-s3');
  const client = new S3Client({
    endpoint: opts.endpoint,
    region: opts.region ?? 'auto',
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    forcePathStyle: opts.forcePathStyle ?? false,
  });
  return {
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket: opts.bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async get(key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: opts.bucket, Key: key }));
        return out.Body ? Buffer.from(await out.Body.transformToByteArray()) : null;
      } catch (err) {
        if (err instanceof NoSuchKey) return null;
        throw err;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: opts.bucket, Key: key }));
    },
  };
}

export const photoKeys = {
  display: (id: string) => `photos/${id}/display.jpg`,
  preview: (id: string) => `photos/${id}/preview.jpg`,
  pending: (captureId: string) => `pending/${captureId}.jpg`,
};
