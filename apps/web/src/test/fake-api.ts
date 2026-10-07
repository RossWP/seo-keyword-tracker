import { vi } from 'vitest';

type Handler = (request: { body: unknown; url: URL }) => Response | Promise<Response>;

export const json = (status: number, body?: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export const apiError = (status: number, code: string, message: string): Response =>
  json(status, { error: { code, message } });

/**
 * Replaces fetch with handlers keyed by "METHOD /path" (the query string is ignored for
 * matching and available as `url.searchParams`). Health answers ok and
 * /api/auth/me answers 401 unless overridden; anything else is a 404 envelope.
 */
export function fakeApi(handlers: Record<string, Handler> = {}) {
  const all: Record<string, Handler> = {
    'GET /health': () => json(200, { status: 'ok', database: 'up' }),
    'GET /api/auth/me': () => apiError(401, 'unauthorized', 'Sign in to continue'),
    ...handlers,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    const handler = all[key];
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    return handler ? handler({ body, url }) : apiError(404, 'not_found', `No fake for ${key}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export const signedInAs = (email = 'alice@agency.test') => ({
  'GET /api/auth/me': () =>
    json(200, {
      user: { id: '0b6f3c9e-1d1f-4c8e-9a51-6f0d1f2b8a11', email, timezone: 'America/Toronto' },
    }),
});
