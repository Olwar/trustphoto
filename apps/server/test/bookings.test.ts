import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, registerInstall, sendCapture, type Harness } from './harness.js';
import { phonePhoto } from './fixtures.js';

// Default Google-call limits (limits.test.ts lowers the global cap on purpose).
let h: Harness;
beforeAll(async () => {
  h = await createHarness({ REQUIRE_ATTESTATION: 'true' });
});
afterAll(async () => {
  await h.close();
});

describe('bookings after Google answered', () => {
  it('gives the booking back when the vision check fails, so the phone can try again', async () => {
    const install = await registerInstall(h.app);
    const photo = await phonePhoto(601, Date.now());
    for (let i = 0; i < 6; i++) {
      h.screenAnswers.push({ screen: null, confidence: null, reason: null, model: 'fake', error: 'timeout' });
      expect((await sendCapture(h.app, install, { photo })).res.statusCode).toBe(503);
    }
    const { rows } = await h.ctx.db.query('SELECT 1 FROM device_check_attempts WHERE install_id = $1', [install.installId]);
    expect(rows).toHaveLength(0);
    expect((await sendCapture(h.app, install, { photo })).res.json()).toMatchObject({ status: 'verified' });
  });

  it('blames the network, not the phone, when other installs at its address used the budget', async () => {
    const address = '198.51.100.77';
    for (let i = 0; i < 7; i++) {
      const junk = await registerInstall(h.app);
      for (let j = 0; j < 5; j++) await sendCapture(h.app, junk, { attestation: { type: 'play_integrity', token: 'junk' }, remoteAddress: address });
    }
    const honest = await registerInstall(h.app);
    const { res } = await sendCapture(h.app, honest, { remoteAddress: address });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toMatchObject({ code: 'device_check_busy', message: expect.stringContaining('this network') });
  });
});

describe('report text', () => {
  it('refuses control characters, and keeps line breaks', async () => {
    const install = await registerInstall(h.app);
    const id = (await sendCapture(h.app, install)).res.json().photo.id;
    const send = (details: string) => h.app.inject({ method: 'POST', url: `/v1/photos/${id}/report`, payload: { reason: 'other', details }, remoteAddress: `192.0.2.${Math.floor(Math.random() * 200) + 1}` });
    expect((await send('\u001b[2Kfake line')).statusCode).toBe(400);
    expect((await send('bad\u009bbyte')).statusCode).toBe(400);
    expect((await send('line one\nline two')).statusCode).toBe(204);
  });
});

describe('bookings that must stay', () => {
  it('refuses an impossible shutter time before any Google call', async () => {
    const install = await registerInstall(h.app);
    let calls = 0;
    const decode = h.ctx.decodePlayIntegrity;
    h.ctx.decodePlayIntegrity = async (token, lane) => {
      calls++;
      return decode(token, lane);
    };
    try {
      const { payload, headers } = await import('./harness.js').then(async ({ multipart }) => {
        const photo = await phonePhoto(701, Date.now());
        return multipart({ v: 1, nonce: '00000000-0000-4000-8000-000000000000', imageSha256: 'a'.repeat(64), captureTimestamp: 1e18, sensorData: [], deviceInfo: { platform: 'android', brand: null, model: null, osVersion: null, appVersion: null, isDevice: true, hasGyroscope: true }, attestation: { type: 'play_integrity', token: 'junk' } }, photo);
      });
      const res = await h.app.inject({ method: 'POST', url: '/v1/captures', payload, headers: { ...headers, ...install.auth } });
      expect(res.statusCode).toBe(400);
      expect(calls).toBe(0);
    } finally {
      h.ctx.decodePlayIntegrity = decode;
    }
  });

  it('keeps the booking of a capture that Google answered, and books nothing for a replay refused before any Google call', async () => {
    const a = await registerInstall(h.app);
    const b = await registerInstall(h.app);
    const first = await sendCapture(h.app, a, { attestation: { type: 'play_integrity', token: 'junk' } });
    expect(first.res.json()).toMatchObject({ status: 'not_verified' });
    const booked = (installId: string) => h.ctx.db.query('SELECT 1 FROM device_check_attempts WHERE install_id = $1', [installId]).then((r) => r.rows.length);
    expect(await booked(a.installId)).toBe(1);
    // The same motion trace from another install: refused as a replay before its Google call.
    const second = await sendCapture(h.app, b, { samples: first.samples, attestation: { type: 'play_integrity', token: 'junk' } });
    expect(second.res.statusCode).toBe(409);
    expect(second.res.json()).toMatchObject({ error: { code: 'duplicate_motion' } });
    expect(await booked(b.installId)).toBe(0);
  });
});

describe('more outages that must not count', () => {
  it('gives the booking back when the temporary copy for the vision check cannot be written', async () => {
    const install = await registerInstall(h.app);
    const photo = await phonePhoto(801, Date.now());
    const put = h.ctx.storage.put;
    h.ctx.storage.put = async () => {
      throw new Error('bucket down');
    };
    try {
      for (let i = 0; i < 6; i++) expect((await sendCapture(h.app, install, { photo })).res.json().error.code).toBe('storage_unavailable');
    } finally {
      h.ctx.storage.put = put;
    }
    expect((await sendCapture(h.app, install, { photo })).res.json()).toMatchObject({ status: 'verified' });
  });

  it('tells a phone with a clock days off to fix the clock', async () => {
    const install = await registerInstall(h.app);
    const { res } = await sendCapture(h.app, install, { captureTimestamp: Date.now() - 3 * 86_400_000 });
    expect(res.json()).toMatchObject({ status: 'not_verified', reason: 'clock' });
  });
});

describe('privacy and platform checks', () => {
  it('stores only a keyed hash of the client address with a Google-call booking', async () => {
    const install = await registerInstall(h.app);
    await sendCapture(h.app, install, { remoteAddress: '198.51.100.23' });
    const { rows } = await h.ctx.db.query<{ client_key: string }>('SELECT client_key FROM device_check_attempts WHERE install_id = $1', [install.installId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].client_key).not.toContain('198.51.100');
    expect(rows[0].client_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a Play Integrity token from an iPhone install before any Google call', async () => {
    const install = await registerInstall(h.app, 'ios');
    let calls = 0;
    const decode = h.ctx.decodePlayIntegrity;
    h.ctx.decodePlayIntegrity = async (token, lane) => {
      calls++;
      return decode(token, lane);
    };
    try {
      const { res } = await sendCapture(h.app, install, { deviceInfo: { platform: 'ios', brand: 'Apple', model: 'iPhone 15' } });
      expect(res.statusCode).toBe(400);
      expect(calls).toBe(0);
    } finally {
      h.ctx.decodePlayIntegrity = decode;
    }
  });
});
