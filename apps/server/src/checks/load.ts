/**
 * Picks the photo checks at start.
 *
 * - `PHOTO_CHECKS_MODULE=reference`: the example in `reference.ts`. Only
 *   this choice by name, together with ALLOW_REFERENCE_CHECKS=true, lets the
 *   reference checks run in production.
 * - `PHOTO_CHECKS_MODULE=<path or package>`: that module. It must export
 *   `photoChecks` (a `PhotoChecks` object) or `createPhotoChecks(env)`.
 * - Not set: a module at `apps/server/private/photo-checks/` when that
 *   folder exists (the build bundles it to `dist/photo-checks.js`), else the
 *   reference checks.
 *
 * The private folder is not part of this repository (.gitignore). See
 * docs/PHOTO-CHECKS.md for how to write a module of your own.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { flag } from '../config.js';
import { createReferenceChecks, visionConfigFromEnv } from './reference.js';
import type { PhotoChecks } from './types.js';

/**
 * Where a private module is looked for: next to the built server
 * (dist/photo-checks.js), then in the source tree (from src/checks/).
 */
const DEFAULT_LOCATIONS = ['./photo-checks.js', '../../private/photo-checks/index.ts'];

type ChecksModule = { photoChecks?: PhotoChecks; createPhotoChecks?: (env: NodeJS.ProcessEnv) => PhotoChecks | Promise<PhotoChecks> };

const REQUIRED: (keyof PhotoChecks)[] = ['name', 'warnings', 'productionProblems', 'visionProvider', 'looksEmulated', 'motionFingerprint', 'analyze', 'askScreen', 'decideScreen', 'decide', 'publicChecks'];

async function importChecks(specifier: string, env: NodeJS.ProcessEnv): Promise<PhotoChecks> {
  let loaded: ChecksModule;
  try {
    loaded = (await import(/* @vite-ignore */ specifier)) as ChecksModule;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not load the photo checks module ${specifier} (start a file path with ./ or /): ${why}`);
  }
  const checks = loaded.createPhotoChecks ? await loaded.createPhotoChecks(env) : loaded.photoChecks;
  const missing = REQUIRED.filter((key) => {
    const value = checks?.[key];
    if (key === 'name') return typeof value !== 'string' || value === '';
    if (key === 'visionProvider') return value !== null && typeof value !== 'string';
    return typeof value !== 'function';
  });
  if (!checks || missing.length > 0) {
    throw new Error(`The photo checks module ${specifier} must export photoChecks or createPhotoChecks(env) with: ${missing.join(', ') || REQUIRED.join(', ')}`);
  }
  return checks;
}

/** Production runs no checks that say they are not fit for it (the reference checks, or a module that lacks a setting). */
export function assertFitForProduction(checks: PhotoChecks): void {
  const problems: unknown = checks.productionProblems();
  if (!Array.isArray(problems)) throw new Error(`The photo checks "${checks.name}" must return an array from productionProblems()`);
  if (problems.length > 0) throw new Error(`The photo checks "${checks.name}" cannot run in production: ${problems.join(' ')}`);
}

/**
 * Loads the photo checks. With `production`, refuses checks that are not fit
 * for it, before the server opens the database.
 */
export async function loadPhotoChecks(env: NodeJS.ProcessEnv = process.env, opts: { production?: boolean } = {}): Promise<PhotoChecks> {
  const checks = await pick(env);
  if (opts.production) assertFitForProduction(checks);
  return checks;
}

async function pick(env: NodeJS.ProcessEnv): Promise<PhotoChecks> {
  // The permission counts only when the operator chose the reference checks by name. A production
  // image that lost its private module must not quietly run the reference checks.
  const reference = (allowInProduction: boolean) => createReferenceChecks({ vision: visionConfigFromEnv(env), allowInProduction });
  const choice = env.PHOTO_CHECKS_MODULE?.trim();
  if (choice === 'reference') return reference(flag(env.ALLOW_REFERENCE_CHECKS, false));
  if (choice) {
    // A path is read from the working directory; anything else is a package name.
    const isPath = choice.startsWith('.') || isAbsolute(choice);
    return importChecks(isPath ? pathToFileURL(resolve(choice)).href : choice, env);
  }
  // The built server (dist/index.js) looks only next to itself; the source tree (src/checks/load.ts) only in private/.
  const fromSource = import.meta.url.endsWith('.ts');
  for (const location of DEFAULT_LOCATIONS.filter((l) => l.endsWith('.ts') === fromSource)) {
    const url = new URL(location, import.meta.url);
    if (existsSync(fileURLToPath(url))) return importChecks(url.href, env);
  }
  return reference(false);
}
