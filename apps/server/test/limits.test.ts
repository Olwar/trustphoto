import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, getNonce, playVerdict, registerInstall, sendCapture, type Harness } from './harness.js';
import { phonePhoto } from './fixtures.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ REQUIRE_ATTESTATION: 'true', UNPROVEN_DAILY_GOOGLE_CALLS: '12' });
});
afterAll(async () => {
  await h.close();
});

describe('Google-call bookings', () => {
  it('does not count calls Google never answered against a new phone', async () => {
    const install = await registerInstall(h.app);
    const decode = h.ctx.decodePlayIntegrity;
    h.ctx.decodePlayIntegrity = async () => ({ ok: false, reason: 'unavailable', error: 'outage' });
    try {
      for (let i = 0; i < 6; i++) expect((await sendCapture(h.app, install)).res.statusCode).toBe(503);
    } finally {
      h.ctx.decodePlayIntegrity = decode;
    }
    expect((await sendCapture(h.app, install)).res.json()).toMatchObject({ status: 'verified' });
  });

  it('caps the calls of all new installs together, and keeps phones that passed before working', async () => {
    const proven = await registerInstall(h.app);
    expect((await sendCapture(h.app, proven)).res.json()).toMatchObject({ status: 'verified' });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const install = await registerInstall(h.app);
      for (let j = 0; j < 4; j++) statuses.push((await sendCapture(h.app, install, { attestation: { type: 'play_integrity', token: 'junk' } })).res.statusCode);
    }
    expect(statuses).toContain(429);
    expect((await sendCapture(h.app, proven)).res.json()).toMatchObject({ status: 'verified' });
  });
});

describe('input', () => {
  it('refuses control characters before anything is spent', async () => {
    const install = await registerInstall(h.app);
    const nonce = await getNonce(h.app, install.auth);
    const { res } = await sendCapture(h.app, install, { nonce, deviceInfo: { model: 'Pixel\u0000 8' }, attestation: (hash) => playVerdict(hash) });
    expect(res.statusCode).toBe(400);
    const { rows } = await h.ctx.db.query('SELECT used_at FROM capture_nonces WHERE nonce = $1', [nonce]);
    expect(rows[0]).toEqual({ used_at: null });
  });

  it('allows at most two open uploads per address', async () => {
    const photos = await Promise.all([1, 2, 3].map((i) => phonePhoto(500 + i, Date.now())));
    const installs = await Promise.all([1, 2, 3].map(() => registerInstall(h.app)));
    const results = await Promise.all(installs.map((install, i) => sendCapture(h.app, install, { photo: photos[i], remoteAddress: '203.0.113.50' })));
    const codes = results.map(({ res }) => (res.statusCode === 200 ? 'ok' : res.json().error.code));
    expect(codes.filter((c) => c === 'rate_limited').length).toBeGreaterThanOrEqual(1);
  });
});

