# The photo checks: what is open and what is not

TrustPhoto is open source with one exception, and this page says exactly what
it is, why it exists, and what you can still verify yourself.

## The short version

| Part | Open? | Why |
| --- | --- | --- |
| Phone app | Yes | |
| Website and "Check a photo" | Yes | |
| Server: upload, device check, binding hash, nonce, replay fences, receipts, storage, limits | Yes | Its safety comes from keys and mathematics, not from secrecy |
| The photo checks **interface** and a **reference** module | Yes | `apps/server/src/checks/` |
| The **tuned photo checks** that the live service runs | **No** | They are rules of thumb, and rules of thumb get weaker when a person can test fakes against them offline |

Signal does the same thing for the same reason: its apps and its server are
open, and its spam filter is not.

## What the photo checks do

After the device check has shown that the genuine app on a real phone sent
exactly these bytes, one question is left: *does this look like a direct camera
photo of a real scene, taken by a phone in a hand?* The photo checks answer it
from three kinds of evidence:

- **the motion trace** that the app records around the shot,
- **the camera file** (the JPEG and its metadata),
- **the picture** (for example: is it a photo of a screen?).

That is all this page says about the live rules. The limits, the weights and
the prompt of the vision check are the private part.

## Why this part is private

A check like "the signature must verify" is safe when everyone knows it. A
check like "a photo of a screen has this kind of pattern" is not: a person who
has the exact rule can change a fake a little, run the rule on their own
computer, and repeat until it passes. Nobody sees the attempts. With the rule
on the server only, each attempt needs a real phone, a real device check and a
real upload, and each one leaves a record.

The same tuned checks also protect SocialHuman, the app that TrustPhoto's
verification comes from. Publishing them would weaken both.

## What this costs you, and what it does not

**You cannot reproduce the live service's verdict on your own computer.** That
is the cost, and we do not hide it.

You can still check these things without trusting us:

- **The receipt.** Each proof carries a receipt signed with Ed25519. The public
  key is at `/.well-known/trustphoto-keys.json`. The signing code is
  `apps/server/src/signing.ts`.
- **The file.** The receipt holds the SHA-256 of the original file and of the
  public copy. "Check a photo" computes the hash in your browser
  (`apps/web/src/client/check.ts`), and you can compute it yourself.
- **What the app sends.** The whole app is here (`apps/mobile`), and so is the
  wire format (`packages/shared/src/protocol.ts`).
- **What the device check proves.** `apps/server/src/attest/` verifies App
  Attest and Play Integrity over the binding hash
  (`packages/shared/src/binding.ts`).
- **What the server keeps and publishes.** `apps/server/src/services/` and the
  migrations in `apps/server/src/db/migrations/`.
- **How "Check a photo" decides.** All of it is open:
  `packages/shared/src/copycheck.ts`.

For the photo checks, a proof page never says more than "phone motion at the
shot", "no screen found" or "no sign of editing", each as passed or "no clear
result". The wording is in
`packages/shared/src/protocol.ts`.

## The interface

`apps/server/src/checks/types.ts` defines `PhotoChecks`. The server calls it
at five points:

| Call | When | What it returns |
| --- | --- | --- |
| `looksEmulated(samples, deviceInfo)` | Before anything is spent | `true` to refuse an emulator |
| `motionFingerprint(samples)` | Before the device check | A loose fingerprint of the trace, or `null` |
| `analyze(input)` | After the device check passed | `passed`, a score and a record for the operator |
| `askScreen(url)` and `decideScreen(answer)` | Only when `analyze` passed | The vision answer and what it means |
| `decide(...)` and `publicChecks(...)` | Last | The final answer and the four facts for the proof page |

The server keeps these jobs for itself, whatever module is loaded:

- It verifies the device check first. A failed device check never reaches
  `analyze`, and in production (or with `REQUIRE_ATTESTATION=true`) neither
  does a missing one.
- It checks the nonce, the photo hash, the exact motion trace and the age of
  the shot.
- When the vision check gives no answer, it stores nothing, so the phone can
  send the same photo again.

## The reference module

`apps/server/src/checks/reference.ts` is a short file that you can read in
one sitting. It tests that the motion trace is long enough and shows gravity,
and that the JPEG names a camera make and model. With `VISION_CHECK_URL` and
`VISION_CHECK_API_KEY` set, it also asks an OpenAI-compatible vision model
whether the photo shows a screen.

A make and a model say nothing about editing, so with these checks the proof
page never shows "No sign of editing" as passed. "No screen found" shows as
passed only after the vision model is sure that the photo shows no screen.

A careful person passes these checks with a fake. For that reason:

- the server logs a warning at start when the reference module is loaded;
- **in production the server refuses to start with it**, unless you choose it
  by name and allow it: `PHOTO_CHECKS_MODULE=reference` and
  `ALLOW_REFERENCE_CHECKS=true`. A production server that finds no module
  never falls back to it.

## Which module runs

`apps/server/src/checks/load.ts` decides at start:

1. `PHOTO_CHECKS_MODULE=reference`: the reference module.
2. `PHOTO_CHECKS_MODULE=<path or package name>`: that module. A relative path
   starts at the folder the server runs in: `apps/server` for `npm run dev`,
   the repository root for `node apps/server/dist/index.js`. An absolute path
   works in both.
3. Not set: the module in `apps/server/private/photo-checks/` when that folder
   exists, else the reference module.

The start log names the module: `{"photoChecks":"reference"}`.

## Write your own

A fork that wants real proofs needs checks of its own. Make a module that
exports `photoChecks` (an object) or `createPhotoChecks(env)` (a function that
returns one):

```ts
import type { PhotoChecks } from '../../src/checks/types.js';

export const photoChecks: PhotoChecks = {
  name: 'my-checks',
  visionProvider: null,
  warnings: () => [],
  productionProblems: () => [],
  looksEmulated: (_samples, deviceInfo) => !deviceInfo.isDevice,
  motionFingerprint: () => null,
  async analyze(_input) {
    // _input.imageBuffer, _input.sensorSamples, _input.deviceInfo, _input.attestation
    return { passed: true, score: 1, record: { note: 'numbers and short notes only' } };
  },
  askScreen: async () => ({ screen: null, confidence: null, reason: null, model: 'none', error: 'not_configured' }),
  decideScreen: () => ({ cleared: false, flagged: false, failed: false }),
  decide: ({ analysis }) => (analysis.passed ? { status: 'verified' } : { status: 'not_verified', reason: 'checks', detail: 'my reason' }),
  publicChecks: (_analysis, attestation) => [
    { key: 'device', state: attestation.bound ? 'passed' : 'inconclusive' },
    { key: 'motion', state: 'inconclusive' },
    { key: 'screen', state: 'inconclusive' },
    { key: 'camera_file', state: 'inconclusive' },
  ],
};
```

Put it at `apps/server/private/photo-checks/index.ts` (the folder is in
`.gitignore`, and `npm run build` bundles it to `dist/photo-checks.js`), or
point `PHOTO_CHECKS_MODULE` at it.

The public server tests always run the reference checks, so they keep
passing with your module in place. Tests of your own in
`apps/server/private/photo-checks/` run with `npm test -w apps/server` and can
use the server's test harness (`apps/server/test/harness.ts`). To run the
public tests with your checks too, add `private/photo-checks/test/setup.ts`
that calls `useCaptureFixtures({ ...plainFixtures, checks: yourChecks })`
(both from `apps/server/test/fixtures.ts`; replace `plainFixtures` with your
own test captures if your checks refuse them). Your module must then also
behave as these public tests expect:

- it verifies the test captures that the fixtures send;
- it refuses a motion trace of 5 samples with the reason `motion`;
- it holds a photo when the vision check is sure that it shows a screen, and
  reports a vision check that gave no answer as `failed`.

Three rules for a module:

1. `record` goes into the database. Put numbers and short notes in it, never
   the photo or the motion trace.
2. Say only what you checked. A `passed` state on the proof page is a public
   claim (guarantee 6 in `docs/REVIEW-CONTRACT.md`).
3. When your vision provider gives no answer, return `failed: true` from
   `decideScreen`. Do not guess.
