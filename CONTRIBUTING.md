# Contributing

Thank you for looking at TrustPhoto. Issues and pull requests are welcome.

For a security problem, do not open an issue. See [SECURITY.md](SECURITY.md).

## Set up

You need Node.js 22 or newer.

```bash
npm install
npm test
npm run typecheck
npm run dev          # website + API on http://localhost:8787
```

`npm run test:reference -w apps/server` sets an environment variable in the
POSIX way, so it needs macOS, Linux or WSL.

Nothing else is needed. The server uses an embedded Postgres and a local
folder, and it runs the reference photo checks.

## What to know before you change something

- **`docs/REVIEW-CONTRACT.md` is the bar.** It lists what a proof guarantees,
  which threats are in scope and which risks are accepted. A change must not
  break a guarantee. A change *to* a guarantee is a decision of the
  maintainers: open an issue first.
- **The photo checks of the live service are private**
  ([docs/PHOTO-CHECKS.md](docs/PHOTO-CHECKS.md)). The public tests run with the
  reference checks. The maintainers also run each change with the private
  checks before a deploy, so a pull request can pass here and still need a
  follow-up. We tell you when that happens.
- **Do not make the reference checks "smarter" to chase fakes.** They are an
  example of the interface, and they must stay short and readable. Better
  checks belong in a module of your own.
- **The wire format is shared.** `packages/shared` is used by the phone, the
  server and the browser. A change there can break phones that are already
  installed. Say in the pull request how old app versions behave.
- **Words on a page are claims.** No screen or page may say more than the
  proof shows (guarantee 6). If you change user-facing text, keep it plain and
  literal.

## Tests

- Write the failing test first when you fix a bug.
- Use the real code. The harness in `apps/server/test/harness.ts` runs the real
  server on an embedded Postgres; only Google's decoder, Apple's one-time key
  attestation and the vision model are fakes. Add a fake only for something that needs a phone or a paid
  service, and say why in a comment.
- **Never commit a real person's photo.** Use the synthetic scenes in
  `apps/server/test/scene.ts` and `fixtures.ts`.
- When you change SQL, run the server tests on a real Postgres too
  (`TEST_DATABASE_URL`, see the README). The embedded database and the small
  test data cannot show a slow query plan.

## Pull requests

- Keep a pull request to one subject. Change only what the subject needs.
- `npm test` and `npm run typecheck` pass.
- Say what you changed, why, and how you tested it. For a change that people
  see, add a screenshot.
- No secrets, keys or personal data in code, tests, logs or screenshots.

## License of contributions

TrustPhoto is licensed under the Apache License 2.0. When you send a pull
request, you license your contribution under the same license (section 5 of
the license). You keep your copyright.
