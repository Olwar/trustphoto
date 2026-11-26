import type { AppConfig } from './config.js';
import type { Db } from './db/index.js';
import type { Storage } from './storage.js';
import type { Signer } from './signing.js';
import type { PlayIntegrityDecoder } from './attest/play-integrity.js';
import type { PhotoChecks, ScreenCheckResult } from './checks/types.js';

/** Everything a request handler needs. Tests build one with fakes for the outside services. */
export interface Context {
  cfg: AppConfig;
  db: Db;
  storage: Storage;
  signer: Signer;
  decodePlayIntegrity: PlayIntegrityDecoder;
  /** The photo checks: the example in src/checks/reference.ts, or a private module (src/checks/load.ts). */
  checks: PhotoChecks;
  /** Asks the vision model about one image URL (the `askScreen` of the photo checks; tests put a fake here). */
  screenCheck: (imageUrl: string) => Promise<ScreenCheckResult>;
  now: () => number;
  /** Runs one verification when a slot is free (decoding full photos is memory-heavy). */
  limitVerification: <T>(task: () => Promise<T>) => Promise<T>;
}
