import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// A checks module in private/photo-checks/ may bring a setup file that installs its checks and its test
// captures (see test/fixtures.ts). It runs unless PHOTO_CHECKS_MODULE=reference; without it the tests run the reference checks.
const privateSetup = fileURLToPath(new URL('./private/photo-checks/test/setup.ts', import.meta.url));
const setupFiles = existsSync(privateSetup) && process.env.PHOTO_CHECKS_MODULE !== 'reference' ? [privateSetup] : [];

export default defineConfig({
  test: {
    setupFiles,
    // The API suites boot an embedded Postgres in beforeAll; on a busy machine that can take longer than the 10 s default.
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
