import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { devSigningKeyPath, loadConfig } from './config.js';
import { migrate, openDb } from './db/index.js';
import { localStorage, s3Storage } from './storage.js';
import { loadSigner } from './signing.js';
import { createPlayIntegrityDecoder } from './attest/play-integrity.js';
import { loadPhotoChecks } from './checks/load.js';
import { buildApp } from './app.js';
import { createConcurrencyLimit } from './limits.js';

const cfg = loadConfig();
const checks = await loadPhotoChecks(process.env, { production: cfg.production });
const db = await openDb({
  databaseUrl: cfg.databaseUrl,
  dataDir: cfg.dataDir ? join(cfg.dataDir, 'db') : null,
  onError: (err) => console.error('[db] idle client error (the pool reconnects):', err.message),
});
const ran = await migrate(db);
const storage = cfg.s3 ? await s3Storage(cfg.s3) : localStorage(join(cfg.dataDir ?? '.data', 'media'));
const signer = await loadSigner({ pem: cfg.signingKeyPem, devKeyPath: devSigningKeyPath(cfg), retiredPublicPems: cfg.retiredSigningPublicKeys });

const webPackage = createRequire(import.meta.url).resolve('@trustphoto/web/package.json');
const app = await buildApp(
  {
    cfg,
    db,
    storage,
    signer,
    decodePlayIntegrity: createPlayIntegrityDecoder(cfg.playIntegrity),
    checks,
    screenCheck: (url) => checks.askScreen(url),
    now: Date.now,
    limitVerification: createConcurrencyLimit(cfg.verifyConcurrency),
  },
  {
    site: { baseUrl: cfg.publicBaseUrl, ...cfg.site, visionProvider: checks.visionProvider },
    publicDir: join(dirname(webPackage), 'public', 'assets'),
    logger: true,
  },
);

if (ran.length > 0) app.log.info({ migrations: ran }, 'database migrated');
if (!cfg.requireAttestation) app.log.warn('REQUIRE_ATTESTATION is off: photos without a device check become test proofs');
app.log.info({ photoChecks: checks.name }, 'photo checks loaded');
for (const warning of checks.warnings()) app.log.warn(warning);

const shutdown = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: cfg.port, host: cfg.host });
