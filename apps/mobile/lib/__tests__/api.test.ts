import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, CancelledError, NetworkError } from '../api';

// fetch is the network: the one thing these tests replace.
afterEach(() => vi.unstubAllGlobals());

describe('apiFetch', () => {
  it('returns the JSON body and sends the token', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ nonce: 'n' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(await apiFetch('/v1/nonce', { method: 'POST', token: 'abc' })).toEqual({ nonce: 'n' });
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ Authorization: 'Bearer abc' });
  });

  it('turns an error body into an ApiError with the server message', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 'nonce_invalid', message: 'Take it again.' } }), { status: 400 }));
    await expect(apiFetch('/x')).rejects.toMatchObject({ status: 400, code: 'nonce_invalid', message: 'Take it again.' });
    await expect(apiFetch('/x')).rejects.toBeInstanceOf(ApiError);
  });

  it('gives up after the timeout with a NetworkError (no AbortSignal.timeout needed)', async () => {
    vi.stubGlobal('AbortSignal', class { static abort() {} });
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    await expect(apiFetch('/x', { timeoutMs: 20 })).rejects.toBeInstanceOf(NetworkError);
  });

  it('reports a cancel by the caller as CancelledError, not as a network problem', async () => {
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    const controller = new AbortController();
    const pending = apiFetch('/x', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
  });

  it('returns nothing for 204', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 204 }));
    expect(await apiFetch('/x', { method: 'DELETE' })).toBeUndefined();
  });
});
