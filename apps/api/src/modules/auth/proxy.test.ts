import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../../lib/passwords.js';
import { createTestContext } from '../../test/context.js';
import { upsertUser } from '../users/users.repository.js';

// Behind nginx the login rate limit must key on the real client IP. Injected requests come
// from 127.0.0.1, which plays the trusted proxy here.
const context = createTestContext({ trustProxy: 'loopback' });
afterAll(() => context.close());
beforeEach(async () => {
  await context.reset();
  await upsertUser(context.db, {
    email: 'alice@agency.test',
    passwordHash: await hashPassword('correct horse battery'),
  });
});

const login = (forwardedFor: string) =>
  context.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'alice@agency.test', password: 'wrong' },
    headers: { 'x-forwarded-for': forwardedFor },
  });

describe('login rate limit behind a proxy', () => {
  it('counts attempts per client IP from X-Forwarded-For, not per proxy', async () => {
    for (let attempt = 0; attempt < 5; attempt++) await login('203.0.113.1');

    expect((await login('203.0.113.1')).statusCode).toBe(429);
    // Another client behind the same proxy is not locked out of the account.
    expect((await login('203.0.113.2')).statusCode).toBe(401);
  });

  it('ignores addresses the client adds to X-Forwarded-For itself', async () => {
    for (let attempt = 0; attempt < 5; attempt++) await login('203.0.113.1');

    // nginx appends the real address last; a spoofed one before it doesn't reset the counter.
    expect((await login('198.51.100.7, 203.0.113.1')).statusCode).toBe(429);
  });
});
