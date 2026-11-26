import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { s3Storage } from '../src/storage.js';

const endpoint = process.env.TEST_S3_ENDPOINT;

// Runs only against an S3-compatible server (see README): the production storage driver.
describe.skipIf(!endpoint)('S3 storage', () => {
  it('stores, reads, answers null for a missing key, and deletes', async () => {
    // The same settings path as a deployment: S3_* names through loadConfig (a self-hosted S3 server needs path-style URLs).
    const cfg = loadConfig({
      S3_ENDPOINT: endpoint,
      S3_BUCKET: process.env.TEST_S3_BUCKET ?? 'trustphoto-test',
      S3_ACCESS_KEY_ID: process.env.TEST_S3_ACCESS_KEY_ID ?? 'test',
      S3_SECRET_ACCESS_KEY: process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'test',
      S3_REGION: 'us-east-1',
      S3_FORCE_PATH_STYLE: 'true',
    });
    const storage = await s3Storage(cfg.s3!);
    const key = `test/${randomUUID()}.jpg`;
    expect(await storage.get(key)).toBeNull();
    await storage.put(key, Buffer.from('hello'), 'image/jpeg');
    expect((await storage.get(key))?.toString()).toBe('hello');
    await storage.delete(key);
    expect(await storage.get(key)).toBeNull();
  });
});
