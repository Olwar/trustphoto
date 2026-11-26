# TrustPhoto

Take a photo in the TrustPhoto app, share its link anywhere, and anyone can see
that a phone camera took it, and when.

- **Live service:** https://trustphoto.fly.dev
- **License:** Apache-2.0
- **Status:** early. The Android app is in closed testing. The iPhone app
  builds, but has not run against the live service yet. See
  [Status and known limits](#status-and-known-limits).

TrustPhoto is made by SocialHuman Technologies Oy. Its verification comes from
[SocialHuman](https://socialhuman.dev), a social app that only accepts photos
and videos taken in its own camera.

## How a proof is made

1. **The app takes the photo.** There is no photo picker. While the camera is
   open, the app records how the phone moves.
2. **The phone commits to the capture.** The app makes one hash over the photo
   bytes, the motion trace, the phone details and a single-use number from the
   server. On iOS, the phone's App Attest key signs that hash. On Android,
   Google signs a Play Integrity verdict that contains it. A change to any
   part after the shot breaks the signature.
3. **The server checks the upload.** The number is fresh and unused, the hash
   matches, the device check verifies, the same photo or motion was never sent
   before, and the photo checks pass (they look for signs of a photo of a
   screen, an edited file or motion that is not a phone in a hand; see
   [docs/PHOTO-CHECKS.md](docs/PHOTO-CHECKS.md)).
4. **The server publishes a proof.** A public page `/p/<id>` shows a copy of
   the photo with no metadata, the phone model, the time, and a receipt signed
   with Ed25519.

Anyone can then open the link, or drop a copy of the photo on the website
("Check a photo") to find its proof. The website also finds a resized,
cropped, mirrored, turned or screenshotted copy, and says "looks like", never
"verified", for those.

## What is open, and the one part that is not

Everything in this list is in this repository:

- the phone app (`apps/mobile`);
- the website and "Check a photo" (`apps/web`, `packages/shared`);
- the server: upload, device check, replay fences, receipts, storage, limits
  (`apps/server`);
- the interface of the photo checks, and a small reference module.

**The tuned photo checks of the live service are private.** They are rules of
thumb (is this a photo of a screen? does the motion look hand-held?), and such
rules get weaker when a person can test fakes against them offline. Signal
makes the same split with its spam filter.
[docs/PHOTO-CHECKS.md](docs/PHOTO-CHECKS.md) says what the private part does,
what you can verify without it, and how to write checks of your own.

A clone of this repository runs with the reference checks. They are an
example, and the server refuses to start with them in production unless you
allow it.

## Layout

```
packages/shared   wire contract, binding hash, pHash, "Check a photo" matching
                  (used by the phone, the server and the browser)
apps/server       Fastify API, device check, photo checks interface, website routes
apps/web          page templates, styles, browser scripts (built with esbuild)
apps/mobile       Expo SDK 55 app: camera, result, photos, photo detail
docs              the photo checks, and the review contract
```

## Run it

You need Node.js 22 or newer. Nothing else: the development server uses an
embedded Postgres and a local folder for photos.

```bash
npm install
npm run dev                    # website + API on http://localhost:8787
npm run demo -w apps/server    # the same with a few seeded proofs, on http://localhost:8790
```

In development the device check is not required (`REQUIRE_ATTESTATION` is
off). A photo without one becomes a **test proof**, and every page shows it as
"not a real proof".

The phone app needs a development build, because Expo Go has no App Attest and
no Play Integrity:

```bash
cd apps/mobile
EXPO_PUBLIC_API_URL=http://<your-computer-LAN-IP>:8787 npx expo run:ios --device
EXPO_PUBLIC_API_URL=http://<your-computer-LAN-IP>:8787 npx expo run:android --device
```

## Test

```bash
npm test                       # shared, server, web and app
npm run typecheck
```

- `apps/server/test/mobile-contract.test.ts` runs the app's real upload code
  (`apps/mobile/lib`) against the server.
- The server tests use an embedded Postgres. To run them on a real Postgres
  (the production driver), give them a server they may create databases on:

  ```bash
  docker run -d --rm --name trustphoto-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine
  until docker exec trustphoto-pg pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; do sleep 1; done
  TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test -w apps/server
  ```

- The S3 storage test runs against an S3 test server:

  ```bash
  docker run -d --rm --name trustphoto-s3 -e COM_ADOBE_TESTING_S3MOCK_STORE_INITIAL_BUCKETS=trustphoto-test -p 59090:9090 adobe/s3mock:5.2.3
  until curl -s -o /dev/null http://127.0.0.1:59090/; do sleep 1; done
  TEST_S3_ENDPOINT=http://127.0.0.1:59090 npm test -w apps/server
  ```

The test photos and motion traces are synthetic (`apps/server/test/fixtures.ts`,
`scene.ts`). They prove the wiring. They say nothing about how real phone
photos score.

## Configuration

All settings are environment variables. `.env.example` lists them with
comments. Development needs none of them.

Production (`NODE_ENV=production`) refuses to start without a database, a
bucket, a signing key, a URL secret, a public URL, the client address header
(`CLIENT_IP_HEADER`), the device-check settings, an operator name and a
contact address. It always requires the device check,
and it refuses the reference photo checks unless you choose them by name
and allow them (`PHOTO_CHECKS_MODULE=reference`, `ALLOW_REFERENCE_CHECKS=true`).

## Run your own

TrustPhoto is one Node.js process plus Postgres and an S3-compatible bucket.

```bash
cp .env.example .env           # then fill it in (see below)
docker build -t trustphoto .
docker run --env-file .env -e PORT=8080 -p 8080:8080 trustphoto
```

- **Postgres 14 or newer.** The server applies its migrations at start.
- **A private bucket** (Cloudflare R2, Amazon S3, or a self-hosted S3 server
  such as MinIO with `S3_FORCE_PATH_STYLE=true`; set `S3_REGION` when your
  provider needs one). Add a lifecycle rule that deletes objects under
  `pending/` after one day.
- **A URL secret** of 32 or more random characters:
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- **A signing key** (Ed25519, PKCS#8 PEM). This prints one on one line, with
  `\n` escapes, as a `.env` file and `docker run --env-file` need:
  `node -e "console.log(JSON.stringify(require('crypto').generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })).slice(1, -1))"`.
  Keep a copy outside the server. A lost key makes every receipt uncheckable.
- **One instance.** The rate limits and the upload limits are counted in
  memory, for each instance.
- **A proxy in front** that sets the client address header
  (`CLIENT_IP_HEADER`), buffers request bodies and can rate-limit.
- **Your own app identity.** The device check only accepts your app:
  change the bundle ID and package name in `apps/mobile/app.json`, the `owner`
  and `projectId` there, the server address and Google Cloud project number in
  `apps/mobile/eas.json`, and set `APP_ATTEST_APP_ID`,
  `PLAY_INTEGRITY_PACKAGE_NAME` and `PLAY_INTEGRITY_SA_JSON` on the server.
  Both device checks work only in a store-signed build.
- **Your own photo checks**, or `PHOTO_CHECKS_MODULE=reference` with
  `ALLOW_REFERENCE_CHECKS=true` (see [docs/PHOTO-CHECKS.md](docs/PHOTO-CHECKS.md)).

`fly.toml`, `apps/mobile/app.json` and `apps/mobile/eas.json` hold the values
of the reference deployment at trustphoto.fly.dev. They are identifiers, not
secrets. Secrets are never in this repository.

### The reference deployment (Fly.io)

```bash
fly deploy --ha=false          # from the repository root
fly logs -a trustphoto
```

The phone app is built with EAS from `apps/mobile`
(`npx eas-cli build --platform android --profile production`).

## Operate it

Verified photos are public, so someone must read the reports.

```bash
npm run moderate -w apps/server -- reports            # open reports, most reported first
npm run moderate -w apps/server -- remove <photoId>   # take a proof down (also for e-mailed requests)
npm run moderate -w apps/server -- dismiss <photoId>  # close the reports of a photo that stays
```

The same tool is in the Docker image: `node apps/server/dist/moderate.js reports`.

After a deploy that changes the search keys of "Check a photo"
(`packages/shared/src/features.ts`), make the keys again for every photo that
is already stored. Until this step ends, a crop or a screenshot of an older
photo gets "No proof found"; full copies are still found.

```bash
node apps/server/dist/backfill-features.js --all
```

Without `--all`, the script makes keys only for photos that have none (after
migration 005).

## Design notes

- **No accounts.** An anonymous install token is the only credential. The
  owner can delete a photo in the app; anyone can report one.
- **No location in public.** The public copy is encoded again with no
  metadata. The server keeps neither the original file nor the motion trace,
  only their hashes.
- **No reviewer.** There is no person who looks at held photos. A photo that
  does not pass is "not verified", with a reason the person can act on.
  Nothing ever says "fake".
- **No final answer from an outage.** When Apple, Google or the vision check
  do not answer, nothing is stored and the phone may send the same photo again.
- **Signed receipts.** Ed25519 over canonical JSON. The public keys, current
  and retired, are at `/.well-known/trustphoto-keys.json`.
- **The phone details and the shutter time are bound** into the device check,
  because the proof page shows the phone model.
- **Fresh shots only.** The newest motion sample must be at most 3 minutes old
  when the upload arrives, plus 2 minutes for clock drift.
- **Replays.** The same photo bytes and the same exact motion trace never
  verify twice.
- **"Check a photo" sends no photo.** The browser sends a SHA-256, a
  perceptual hash in eight orientations and search keys of local features. For
  a possible match it also sends one on/off value for each of 2,304 grid cells
  and how the file sits on the photo. The server compares those values with
  the stored photo and decides. It names no photo before that.
- **Abuse limits.** One upload at a time for each install, two for each client
  address, a cap for each instance. Uploads with no device check stop before
  any image decode. Every Google (Play Integrity) call is booked against a
  budget, so free install tokens cannot spend the quota that real phones need,
  and a call that Google never answered is given back.

## Status and known limits

1. **Real phones.** One live run so far: a Play-installed build on a Samsung
   S24 made a verified proof on the reference deployment (2026-11-25). The
   iPhone app and Apple key registration have never run live. Every capture
   test in this repository is synthetic.
2. **The privacy page is a draft.** It has had no legal review.
3. **No explicit-content check.** Verified photos are public, and only reports
   and the operator stand between a bad photo and its page.
4. **Scale.** The search behind "Check a photo" reads every photo. It is
   planned for a few thousand photos. Past that it needs an inverted index for
   the feature keys and an index for the perceptual hash. A search that runs
   out of time answers "busy", never "no proof".
5. **Limits in memory.** Rate limits and in-flight upload limits are counted
   for each instance. The Google-call budgets are in the database.
6. **Delete after a reinstall.** The install token is the only owner
   credential. After a reinstall on Android, or on a new phone, the person
   writes to the operator, who removes the photo.
7. **Shot time.** The phone fetches the server's number after the shutter. A
   person who sets the phone clock ahead before a shot and uploads later can
   make an older photo look fresh by that amount.
8. **iOS and Android differ.** Play Integrity also says whether the phone is a
   certified, unmodified Android device. App Attest proves the genuine app on
   genuine Apple hardware, and gives no such verdict about the device.
9. **Advisories in the phone app's libraries.** `npm audit` reports
   advisories in packages that come with Expo SDK 55. Most are in the tools
   that build the app. One high advisory is in the app itself: the URL
   decoder of the app's router can be made slow by a crafted link (a denial of
   service on the phone that opens the link). These go away with an Expo
   upgrade. The server, the website and the shared code have none, and CI
   checks that they stay that way.
10. **Accepted risks.** [docs/REVIEW-CONTRACT.md](docs/REVIEW-CONTRACT.md) lists
   the guarantees, the threats in scope and the risks we accept, among them: a
   genuine but compromised phone; abuse from many addresses without a proxy in
   front; another photo taken from the same spot can read as "looks like".

## Security

Please report a vulnerability in private. [SECURITY.md](SECURITY.md) says how.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) says
how to set up, what the tests expect and what a change needs.

## License

Copyright 2026 SocialHuman Technologies Oy.

Licensed under the [Apache License, Version 2.0](LICENSE). Third-party
material is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

"TrustPhoto" and "SocialHuman" are names of SocialHuman Technologies Oy. The
license covers the code. It does not give you the right to use these names for
your own service (section 6 of the license).
