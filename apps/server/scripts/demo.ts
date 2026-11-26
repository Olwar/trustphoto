/**
 * Local demo for screenshots and design review: the real app on an
 * in-memory database, with the two outside services faked (Google's Play
 * Integrity decoder and the vision model). Seeds two verified proofs and
 * one test proof, then prints their URLs.
 *
 *   npm run demo -w apps/server        (http://localhost:8790)
 */

import { createHarness, playVerdict, registerInstall, sendCapture } from '../test/harness.js';
import { landscapePhoto } from '../test/scene.js';

const PORT = Number(process.env.PORT ?? 8790);
const h = await createHarness({
  PUBLIC_BASE_URL: `http://localhost:${PORT}`,
  OPERATOR_NAME: process.env.OPERATOR_NAME ?? 'TrustPhoto demo',
  CONTACT_EMAIL: process.env.CONTACT_EMAIL ?? 'privacy@example.com',
});
const install = await registerInstall(h.app);
const device = { brand: 'Google', model: 'Pixel 9 Pro' };

for (const [seed, attestation] of [
  [1, undefined],
  [2, undefined],
  [3, { type: 'none', reason: 'dev_build' } as const],
] as const) {
  const { res } = await sendCapture(h.app, install, {
    photo: await landscapePhoto(seed, Date.now() - 800),
    deviceInfo: device,
    attestation: attestation ?? ((hash) => playVerdict(hash)),
  });
  const body = res.json();
  console.log(body.status === 'verified' ? `${body.photo.isTest ? 'test proof' : 'verified  '}  ${body.photo.url}` : JSON.stringify(body));
}

await h.app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`demo running at http://localhost:${PORT}`);
