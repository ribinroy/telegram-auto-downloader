// Test-only helpers for the transport layer: canned responses, a hand-built
// JWT (the code only ever reads `exp`), and a way to read back what a stubbed
// fetch was asked for.
import { vi, type Mock } from 'vitest';

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A reply whose body isn't JSON - what a proxy or a crash page sends. */
export const textResponse = (text: string, status = 200) => new Response(text, { status });

const base64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** `header.payload.sig` with the given claims; the signature is never checked client-side. */
export const jwt = (payload: Record<string, unknown>) => `h.${base64url(JSON.stringify(payload))}.s`;

/** A media/access token that expires `seconds` from now (negative = already expired). */
export const tokenExpiringIn = (seconds: number, now = Date.now()) =>
  jwt({ exp: Math.floor(now / 1000) + seconds });

export type FetchMock = Mock<typeof fetch>;

/** Replace global fetch with a mock answering the given replies in call order.
 *  An Error entry rejects (a network failure); the last reply repeats. */
export function stubFetch(...replies: (Response | Error)[]): FetchMock {
  const mock = vi.fn<typeof fetch>();
  replies.forEach((reply, i) => {
    // A body can be read once, so every call gets its own copy of the reply.
    const impl = () => (reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply.clone()));
    if (i === replies.length - 1) mock.mockImplementation(impl);
    else mock.mockImplementationOnce(impl);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

export interface SentRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** JSON bodies are parsed; anything else (FormData) is returned as is. */
  body: unknown;
  init: RequestInit | undefined;
}

/** What the n-th fetch call asked for. */
export function sentRequest(mock: FetchMock, n = 0): SentRequest {
  const call = mock.mock.calls[n];
  if (!call) throw new Error(`fetch was called ${mock.mock.calls.length} time(s), no call #${n}`);
  const [input, init] = call;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const headers = (init?.headers ?? {}) as Record<string, string>;
  let body: unknown = init?.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { /* not JSON - leave the string */ }
  }
  return { url, method: init?.method ?? 'GET', headers, body, init };
}

/** Swap window.location for one whose reload() is a spy; returns the spy and a restore. */
export function stubReload(): { reload: Mock<() => void>; restore: () => void } {
  const original = window.location;
  const reload = vi.fn<() => void>();
  Object.defineProperty(window, 'location', {
    configurable: true, writable: true,
    value: { ...original, reload, origin: original.origin, href: original.href },
  });
  return { reload, restore: () => { Object.defineProperty(window, 'location', { configurable: true, writable: true, value: original }); } };
}

/** Let `setTimeout(..., 0)` callbacks run (the transport clears its in-flight
 *  promises on the next tick, so a test must wait a tick before the next). */
export const nextTick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
