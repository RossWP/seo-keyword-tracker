import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../../lib/passwords.js';
import { createTestContext } from '../../test/context.js';
import { upsertUser } from '../users/users.repository.js';
import { SESSION_TTL_MS } from './auth.service.js';

const context = createTestContext();
const password = 'correct horse battery';
let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(password);
});
beforeEach(async () => {
  await context.reset();
  await upsertUser(context.db, { email: 'alice@agency.test', passwordHash });
});
afterAll(() => context.close());

function login(email: string, pass: string, headers: Record<string, string> = {}) {
  return context.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: pass },
    headers,
  });
}

async function sessionCookie(): Promise<string> {
  const response = await login('alice@agency.test', password);
  const cookie = response.cookies.find((c) => c.name === 'sid');
  if (!cookie) throw new Error('no session cookie');
  return `sid=${cookie.value}`;
}

const me = (cookie?: string) =>
  context.app.inject({ method: 'GET', url: '/api/auth/me', headers: cookie ? { cookie } : {} });

describe('POST /api/auth/login', () => {
  it('signs in and sets an httpOnly session cookie', async () => {
    const response = await login('alice@agency.test', password);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      user: { email: 'alice@agency.test', timezone: 'America/Toronto' },
    });
    const cookie = response.cookies.find((c) => c.name === 'sid');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(cookie?.expires?.getTime()).toBe(context.clock.now.getTime() + SESSION_TTL_MS);
  });

  it('accepts the email in any case and with surrounding spaces', async () => {
    const response = await login('  Alice@Agency.TEST ', password);
    expect(response.statusCode).toBe(200);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const wrongPassword = await login('alice@agency.test', 'nope');
    const unknownEmail = await login('nobody@agency.test', password);

    for (const response of [wrongPassword, unknownEmail]) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: { code: 'invalid_credentials', message: 'Email or password is incorrect' },
      });
      expect(response.cookies).toHaveLength(0);
    }
  });

  it('rejects an invalid body with field errors', async () => {
    const response = await login('not-an-email', '');
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'validation_error' } });
  });

  it('rate-limits repeated attempts for the same email and IP', async () => {
    for (let attempt = 0; attempt < 5; attempt++) await login('alice@agency.test', 'wrong');
    const blocked = await login('alice@agency.test', password);

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: { code: 'rate_limited' } });
    // Another account from the same IP is not locked out.
    expect((await login('bob@agency.test', 'whatever')).statusCode).toBe(401);
  });

  it('rejects cross-origin and opaque-origin logins', async () => {
    for (const origin of ['https://evil.example', 'null']) {
      const response = await login('alice@agency.test', password, { origin });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'forbidden_origin' } });
    }
  });

  it('accepts a same-origin login', async () => {
    const response = await login('alice@agency.test', password, {
      host: 'tracker.test',
      origin: 'https://tracker.test',
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('GET /api/auth/me', () => {
  it('returns the signed-in user', async () => {
    const response = await me(await sessionCookie());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { email: 'alice@agency.test' } });
  });

  it('returns 401 without a cookie or with an unknown token', async () => {
    expect((await me()).statusCode).toBe(401);
    const forged = await me('sid=forged-token');
    expect(forged.statusCode).toBe(401);
    expect(forged.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('rejects an expired session', async () => {
    const cookie = await sessionCookie();
    context.clock.now = new Date(context.clock.now.getTime() + SESSION_TTL_MS + 1);
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it('extends the session once past half its lifetime', async () => {
    const cookie = await sessionCookie();

    context.clock.now = new Date(context.clock.now.getTime() + SESSION_TTL_MS / 4);
    expect((await me(cookie)).cookies).toHaveLength(0);

    context.clock.now = new Date(context.clock.now.getTime() + SESSION_TTL_MS / 2);
    const renewed = (await me(cookie)).cookies.find((c) => c.name === 'sid');
    expect(renewed?.expires?.getTime()).toBe(context.clock.now.getTime() + SESSION_TTL_MS);

    // Still valid past the original expiry.
    context.clock.now = new Date(context.clock.now.getTime() + SESSION_TTL_MS / 2);
    expect((await me(cookie)).statusCode).toBe(200);
  });
});

describe('POST /api/auth/logout', () => {
  it('ends the session so the same cookie no longer works', async () => {
    const cookie = await sessionCookie();
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(204);
    expect(response.cookies.find((c) => c.name === 'sid')?.value).toBe('');
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it('succeeds without a session', async () => {
    const response = await context.app.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(response.statusCode).toBe(204);
  });
});
