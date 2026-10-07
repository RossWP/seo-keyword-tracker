import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from './app.js';
import { AppError } from './lib/errors.js';

function createApp(checkDatabase: () => Promise<void> = () => Promise.resolve()) {
  return buildApp({ logger: false, checkDatabase });
}

describe('GET /health', () => {
  it('returns 200 when the database answers', async () => {
    const app = createApp();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', database: 'up' });
  });

  it('returns 503 when the database check fails', async () => {
    const app = createApp(() => Promise.reject(new Error('connection refused')));
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable', database: 'down' });
  });

  it('echoes the request id', async () => {
    const app = createApp();
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'abc-123' },
    });
    expect(response.headers['x-request-id']).toBe('abc-123');
  });
});

describe('error envelope', () => {
  it('returns 404 for unknown routes', async () => {
    const app = createApp();
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'not_found', message: 'Route GET /nope not found' },
    });
  });

  it('returns 400 with field paths for invalid input', async () => {
    const app = createApp();
    app.post(
      '/echo',
      { schema: { body: z.object({ email: z.email() }) } },
      async (request) => request.body,
    );
    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      payload: { email: 'not-an-email' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'validation_error',
        details: { issues: [{ path: 'body.email' }] },
      },
    });
  });

  it('returns 400 for malformed JSON', async () => {
    const app = createApp();
    app.post('/echo', async (request) => request.body);
    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"broken"',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'bad_request' } });
  });

  it('maps AppError to its status and code', async () => {
    const app = createApp();
    app.get('/conflict', async () => {
      throw new AppError(409, 'duplicate_site', 'Site already added', { clientId: 'c1' });
    });
    const response = await app.inject({ method: 'GET', url: '/conflict' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: { code: 'duplicate_site', message: 'Site already added', details: { clientId: 'c1' } },
    });
  });

  it('hides unexpected errors behind a generic 500', async () => {
    const app = createApp();
    app.get('/boom', async () => {
      throw new Error('secret internals');
    });
    const response = await app.inject({ method: 'GET', url: '/boom' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: 'internal_error', message: 'Something went wrong' },
    });
  });
});
