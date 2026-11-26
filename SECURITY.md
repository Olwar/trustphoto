# Security

TrustPhoto makes a public claim about a photo. A way to make a false claim, or
to take a true one down, is a security problem, and we want to hear about it.

## How to report

- Use **GitHub private vulnerability reporting**: the "Report a vulnerability"
  button under the Security tab of this repository.
- Or write to **hello@socialhuman.dev** with "TrustPhoto security" in the
  subject.

Please do not open a public issue for a problem that someone can use today.

Tell us what you did, what happened and what you expected. A short script or a
list of requests helps most. We answer within five working days. When a fix
is live we say so, and we credit you if you want that.

## What is in scope

- A verified proof for a photo that the TrustPhoto app did not take, or for
  bytes that changed after the shot.
- A second proof from the same photo, motion trace or nonce.
- A forged or altered receipt that still checks against the published key.
- Reading, changing or deleting another install's photos.
- Private data in a public copy (metadata, location), in a log or in an answer
  of the server.
- "Check a photo" naming or showing a photo to someone whose file does not
  match it.
- Anything that lets one source stop the service for everyone at low cost.

## What to know first

- **The photo checks of the live service are private** (see
  `docs/PHOTO-CHECKS.md`). The checks in `apps/server/src/checks/reference.ts`
  are an example, and they are easy to pass on purpose. "The reference checks
  accept my fake" is not a vulnerability. "The live service gave my fake a
  proof" is one: please report it privately, with the proof link.
- The accepted risks are listed in `docs/REVIEW-CONTRACT.md`. A report about
  one of them is still welcome when it shows that the risk is larger than the
  text says.

## Rules for testing

- Test on your own server (`npm run dev`) when you can.
- On the live service, use only photos and installs of your own. Do not report,
  delete or look up other people's photos beyond what your report needs.
- No load tests and no floods on the live service.
- Delete the test proofs that you made when you are done.

## Supported versions

Only the newest commit on `main` and the live service get fixes.
