import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Apple's attestation object needs Apple's CA and a real Secure Enclave, so
// only that one verifier is replaced; the routes, challenges and database run for real.
vi.mock('../src/attest/app-attest.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/attest/app-attest.js')>();
  return {
    ...real,
    verifyKeyAttestation: vi.fn(async (_cfg: unknown, keyId: string, _challenge: string, attestation: string) =>
      attestation === 'good'
        ? { ok: true as const, publicKeyPem: `pem-${keyId}`, signCount: 0 }
        : { ok: false as const, reason: 'invalid_attestation' as const, error: 'bad chain' },
    ),
  };
});

const { createHarness, registerInstall } = await import('./harness.js');
type Harness = Awaited<ReturnType<typeof createHarness>>;

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ APP_ATTEST_APP_ID: 'TEAMID.com.socialhuman.trustphoto' });
});
afterAll(async () => {
  await h.close();
});

async function challenge(auth: Record<string, string>): Promise<string> {
  return (await h.app.inject({ method: 'POST', url: '/v1/app-attest/challenge', headers: auth })).json().challenge;
}
const register = (auth: Record<string, string>, body: object) => h.app.inject({ method: 'POST', url: '/v1/app-attest/register', headers: auth, payload: body });

describe('App Attest registration', () => {
  it('registers a key once per challenge', async () => {
    const install = await registerInstall(h.app, 'ios');
    const c = await challenge(install.auth);
    expect((await register(install.auth, { keyId: 'k1', challenge: c, attestation: 'good' })).statusCode).toBe(204);
    expect((await register(install.auth, { keyId: 'k1', challenge: c, attestation: 'good' })).json().error.code).toBe('challenge_invalid');
    const { rows } = await h.ctx.db.query('SELECT app_attest_key_id FROM installs WHERE id = $1', [install.installId]);
    expect(rows[0]).toEqual({ app_attest_key_id: 'k1' });
  });

  it("refuses an expired challenge and another install's challenge", async () => {
    const a = await registerInstall(h.app, 'ios');
    const b = await registerInstall(h.app, 'ios');
    const c = await challenge(a.auth);
    expect((await register(b.auth, { keyId: 'kb', challenge: c, attestation: 'good' })).json().error.code).toBe('challenge_invalid');
    h.clock.offsetMs = 61_000;
    try {
      expect((await register(a.auth, { keyId: 'ka', challenge: c, attestation: 'good' })).json().error.code).toBe('challenge_invalid');
    } finally {
      h.clock.offsetMs = 0;
    }
  });

  it('refuses an attestation Apple did not sign, and spends the challenge', async () => {
    const install = await registerInstall(h.app, 'ios');
    const c = await challenge(install.auth);
    expect((await register(install.auth, { keyId: 'k2', challenge: c, attestation: 'forged' })).statusCode).toBe(400);
    expect((await register(install.auth, { keyId: 'k2', challenge: c, attestation: 'good' })).json().error.code).toBe('challenge_invalid');
  });

  it('replaces the key of the same install, and refuses a key another install holds', async () => {
    const a = await registerInstall(h.app, 'ios');
    const b = await registerInstall(h.app, 'ios');
    expect((await register(a.auth, { keyId: 'shared', challenge: await challenge(a.auth), attestation: 'good' })).statusCode).toBe(204);
    expect((await register(a.auth, { keyId: 'new', challenge: await challenge(a.auth), attestation: 'good' })).statusCode).toBe(204);
    expect((await register(b.auth, { keyId: 'new', challenge: await challenge(b.auth), attestation: 'good' })).json().error.code).toBe('key_in_use');
  });
});
