# TrustPhoto v1 — review contract

This file is the fixed bar for every review of v1. A finding blocks a release
only if it breaks a guarantee below, makes a threat in scope work, or makes a
user-facing claim untrue. Accepted risks do not block a release while
README.md states them honestly.

## Guarantees

1. **Proof integrity.** A verified proof means: the genuine TrustPhoto app on
   a real phone (App Attest / Play Integrity, bound to the capture) took these
   exact bytes, with this motion trace and these phone details, after a fresh
   single-use server nonce, at most a few minutes before the upload, and the
   photo checks passed (on the TrustPhoto service: SocialHuman's photo
   verification plus a vision screen check that fails closed; the service's
   private checks module refuses a production start without the vision check,
   through `productionProblems()`; see guarantee 8 for the boundary).
2. **No replay.** The same photo, the same exact motion trace, a reused nonce
   or another install's nonce never makes a second proof.
3. **Safe retries.** The same install sending the same photo again gets the
   stored answer. An outage (Apple, Google, the vision provider, a busy
   server) never stores a final "not verified" and never counts against the
   phone.
4. **Privacy.** Public copies carry no metadata (no GPS). The browser "Check a
   photo" sends no photo: it sends hashes and, for a possible match, one
   on/off value for each of 2,304 grid cells with the position of the grid
   (changed 2026-11-25). The server keeps no original file and no motion
   trace. Logs carry no client addresses.
5. **Ownership.** Only the install that took a photo can delete it in the app.
6. **Honest copy.** No page or app screen claims more than the proof shows; a
   test proof or a "looks like" match never reads as a verified original; the
   user is told what becomes public, who can find it, how deletion works and
   its limits.
7. **Accessibility.** WCAG 2.2 AA on the website; the app follows iOS HIG and
   supports large text and screen readers.

8. **An honest boundary.** The repository is open source except for the tuned
   photo checks of the TrustPhoto service, which sit behind the interface in
   `apps/server/src/checks/` (decided 2026-11-26; `docs/PHOTO-CHECKS.md` gives
   the reason). Everything else that a proof depends on is public: the device
   check, the binding hash, the nonce, the replay fences, the receipt and
   "Check a photo". The server never runs the public reference checks in
   production unless the operator sets `ALLOW_REFERENCE_CHECKS=true`, and no
   page or document presents the reference checks as the checks of the
   service.

## Threats in scope (v1)

- Forged, edited, replayed or re-signed captures; tampered clients without a
  genuine device attestation.
- Cheap abuse from one source: free install tokens, forged forwarding
  headers, address rotation inside one IPv6 /64, huge, malformed, slow or
  out-of-order uploads, junk device tokens, control characters in input.
- Routine infrastructure events: a database connection drop or restart, a
  provider outage or quota answer, two instances starting together.

## Accepted risks (stated in README.md)

- **Distributed abuse** from many addresses (a botnet, many IPv6 /48s). The
  server's limits are per instance and per address; the deployment must sit
  behind an edge (Cloudflare / Fly proxy) that buffers request bodies and can
  rate-limit or block. A global daily cap on Google calls for new installs
  keeps most of the quota for phones that passed before.
- **Compromised genuine devices** that still pass App Attest / Play Integrity.
- **Clock-ahead trick**: a phone clock set ahead before a shot can make an old
  shot look fresh by that amount (the nonce is fetched after the shutter).
- **Near-copy search**: "Check a photo" finds a proof from any close copy of
  the photo, or of a part of it, so someone who holds similar images can find
  proof pages. A second photo of the same scene from the same spot can read
  as "looks like". A lookup gives anyone the positions of matching corners of
  up to three photos, with no picture and no link. (Changed 2026-11-25 with
  the search for cropped, mirrored and turned copies.)
- **Rare storage orphans**: a crash between writing the public files and the
  database commit can leave unlinked files under an unguessable key.
- **Per-instance memory limits** (rate limits, in-flight uploads).
- **Little device testing**: one live Android run (2026-11-25). The iPhone
  app has not run against the live service.
- **A private part**: nobody outside can reproduce the service's photo-check
  verdict (guarantee 8). The receipt, the hashes and the device check stay
  checkable.
- **Reference checks in a fork**: a fork that runs the reference checks in
  production makes proofs that a careful fake can get. The start log and the
  documents say so; the code cannot stop an operator who allows it.

## Owner decisions (not code)

- `OPERATOR_NAME` and `CONTACT_EMAIL` (production refuses to start without
  them), who reads reports (`npm run moderate`) and how fast, and a legal
  review of the privacy page, which is a draft.
- Open source under Apache-2.0, with the tuned photo checks private (owner
  decision, 2026-11-26).
- Apple / Google setup, store listings, and the edge in front of the server.
