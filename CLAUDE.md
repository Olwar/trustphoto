# TrustPhoto — notes for AI coding agents

A camera app that gives each photo a public proof page. `README.md` has the
features, the configuration and the known limits. Read it before a larger
change. `CONTRIBUTING.md` has the rules for a change; they apply to agents too.

## Structure (npm workspaces)

- `packages/shared/` — wire contract, binding hash, pHash, "Check a photo" matching (used by phone, server and browser)
- `apps/server/` — Fastify API, device check, photo checks interface, website routes, migrations (`src/db/migrations/`)
- `apps/web/` — page templates, styles, browser scripts (built with esbuild)
- `apps/mobile/` — Expo SDK 55 app: camera, result, photos, photo detail
- `docs/REVIEW-CONTRACT.md` — the fixed guarantees, threats in scope and accepted risks. **A change to a guarantee is a maintainer decision: ask first, and state the change in the summary.**
- `docs/PHOTO-CHECKS.md` — the one private part (the tuned photo checks) and the public interface in `apps/server/src/checks/`.

## Commands

```bash
npm install
npm run dev                    # website + API on http://localhost:8787, embedded Postgres in apps/server/.data/
npm test                       # all workspaces
npm test -w apps/server        # also -w packages/shared, apps/web, apps/mobile
npm run test:reference -w apps/server   # the server tests with the reference checks only
npm run typecheck
```

Prefer `-w <workspace>` over `cd`.

## Rules

- **The photo checks boundary.** `apps/server/private/` is not part of this repository. Never copy code, limits or prompts from a private module into a tracked file, a test, a comment, a commit message or an issue. Public code talks to the checks only through `PhotoChecks` (`apps/server/src/checks/types.ts`). Keep `reference.ts` short and readable; it is an example, not a detector.
- **Tests must pass in both modes** when a private module with a test setup file is present: `npm test -w apps/server` (the public tests run the private checks) and `npm run test:reference -w apps/server` (the reference checks, as in CI).
- **Run the server tests on real Postgres when you change SQL** (`TEST_DATABASE_URL`, see `README.md`). The embedded database and the small test data cannot show a slow query plan.
- **Test data.** Never use a real person's photos or media as test data. Use the synthetic scenes (`apps/server/test/scene.ts`, `fixtures.ts`) or public images.
- **Secrets.** Never commit them, never print their values. Settings are environment variables (`.env.example`).
- **No new TypeScript errors.** Run `npm run typecheck` before and after.
- **Words on a page are claims.** No page or screen may say more than the proof shows.
- **Never trust comments or docs over code.** Verify the implementation before you rely on a claim, including the claims in this file.
- **Think before coding.** State assumptions. Ask when the request is unclear.
- **Surgical changes only.** Every changed line traces to the request. Match the existing style. Do not refactor what is not broken.
- **Red-Green-Refactor.** Failing test first, minimal code to pass, then refactor.
- **Avoid mocks.** Prefer the real implementation; fake only what needs a phone or a paid service, and say why.
- **When unsure about a library or an API, look it up.** Never commit code on a guessed API shape.
- **Do not build or verify on emulators, simulators or physical devices unless you are asked to.**
- **Git.** Work on the current branch unless asked. Never stash, reset or clean a dirty tree without asking. Stage only the files you changed.
