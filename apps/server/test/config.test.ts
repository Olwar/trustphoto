import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const keys = { endpoint: 'https://s3.example', bucket: 'media', accessKeyId: 'id', secretAccessKey: 'secret' };
/** The defaults: virtual-host URLs and no region (the storage then uses "auto", right for R2). */
const bucket = { ...keys, region: undefined, forcePathStyle: false };

describe('the photo bucket settings', () => {
  it('reads the S3_* names', () => {
    const cfg = loadConfig({ S3_ENDPOINT: bucket.endpoint, S3_BUCKET: bucket.bucket, S3_ACCESS_KEY_ID: bucket.accessKeyId, S3_SECRET_ACCESS_KEY: bucket.secretAccessKey });
    expect(cfg.s3).toEqual(bucket);
  });

  it('reads the names that `fly storage create` sets on the app', () => {
    const cfg = loadConfig({
      AWS_ENDPOINT_URL_S3: bucket.endpoint,
      BUCKET_NAME: bucket.bucket,
      AWS_ACCESS_KEY_ID: bucket.accessKeyId,
      AWS_SECRET_ACCESS_KEY: bucket.secretAccessKey,
    });
    expect(cfg.s3).toEqual(bucket);
  });

  it('prefers the S3_* names when both are set', () => {
    const cfg = loadConfig({
      S3_ENDPOINT: bucket.endpoint,
      S3_BUCKET: bucket.bucket,
      S3_ACCESS_KEY_ID: bucket.accessKeyId,
      S3_SECRET_ACCESS_KEY: bucket.secretAccessKey,
      AWS_ENDPOINT_URL_S3: 'https://other.example',
      BUCKET_NAME: 'other',
      AWS_ACCESS_KEY_ID: 'other',
      AWS_SECRET_ACCESS_KEY: 'other',
    });
    expect(cfg.s3).toEqual(bucket);
  });

  it('refuses to start in production when only some S3_* names are set, even if the Fly names are complete', () => {
    const env = {
      NODE_ENV: 'production',
      S3_ENDPOINT: bucket.endpoint,
      S3_BUCKET: bucket.bucket,
      AWS_ENDPOINT_URL_S3: 'https://other.example',
      BUCKET_NAME: 'other',
      AWS_ACCESS_KEY_ID: 'other',
      AWS_SECRET_ACCESS_KEY: 'other',
    };
    expect(() => loadConfig(env)).toThrow(/only some are set/);
  });

  it('reads the region and the path-style setting for self-hosted S3 servers', () => {
    const cfg = loadConfig({ S3_ENDPOINT: keys.endpoint, S3_BUCKET: keys.bucket, S3_ACCESS_KEY_ID: keys.accessKeyId, S3_SECRET_ACCESS_KEY: keys.secretAccessKey, S3_REGION: 'eu-north-1', S3_FORCE_PATH_STYLE: 'true' });
    expect(cfg.s3).toEqual({ ...keys, region: 'eu-north-1', forcePathStyle: true });
  });

  it('has no bucket when a part is missing', () => {
    expect(loadConfig({ AWS_ENDPOINT_URL_S3: bucket.endpoint, BUCKET_NAME: bucket.bucket }).s3).toBeNull();
  });
});
