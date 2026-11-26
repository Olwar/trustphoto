import type { ApiError as ApiErrorBody } from '@trustphoto/shared';

/** The server. Set EXPO_PUBLIC_API_URL to your computer's LAN address when you run the app on a phone in development. */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8787').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** No answer from the server at all (offline, timeout, DNS). */
export class NetworkError extends Error {}

/** The caller cancelled the request. */
export class CancelledError extends Error {}

export async function apiFetch<T>(
  path: string,
  init: RequestInit & { token?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const { token, timeoutMs = 20_000, headers, signal, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel);
  try {
    let res: Response;
    try {
      res = await fetch(`${API_URL}${path}`, {
        ...rest,
        headers: {
          Accept: 'application/json',
          ...(rest.body && typeof rest.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        signal: controller.signal,
      });
    } catch {
      if (signal?.aborted) throw new CancelledError('Cancelled.');
      throw new NetworkError('No connection to TrustPhoto.');
    }
    if (res.status === 204) return undefined as T;
    const body = (await res.json().catch(() => null)) as (T & Partial<ApiErrorBody>) | null;
    if (!res.ok) {
      throw new ApiError(res.status, body?.error?.code ?? 'unknown', body?.error?.message ?? 'Something went wrong. Try again.');
    }
    return body as T;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
