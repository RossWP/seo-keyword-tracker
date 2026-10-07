import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { clients } from '../../db/schema.js';
import { createTestContext } from '../../test/context.js';
import { signedInUser } from '../../test/factories.js';

const context = createTestContext();
afterAll(() => context.close());

let alice: Awaited<ReturnType<typeof signedInUser>>;
let bob: Awaited<ReturnType<typeof signedInUser>>;

beforeEach(async () => {
  await context.reset();
  alice = await signedInUser(context, 'alice@agency.test');
  bob = await signedInUser(context, 'bob@agency.test');
});

const create = (cookie: string, payload: Record<string, unknown>) =>
  context.app.inject({ method: 'POST', url: '/api/clients', headers: { cookie }, payload });

describe('POST /api/clients', () => {
  it('creates a pending client for the signed-in user and schedules its crawl', async () => {
    const response = await create(alice.cookie, {
      name: ' Acme ',
      websiteUrl: 'https://WWW.Acme.example/blog/',
    });

    expect(response.statusCode).toBe(202);
    const client = response.json<{ id: string }>();
    expect(response.headers.location).toBe(`/api/clients/${client.id}`);
    expect(client).toMatchObject({
      name: 'Acme',
      websiteUrl: 'https://www.acme.example/blog/',
      crawlStatus: 'pending',
    });
    expect(context.enqueued).toEqual([client.id]);

    const [row] = await context.db.select().from(clients).where(eq(clients.id, client.id));
    expect(row).toMatchObject({ userId: alice.user.id, siteKey: 'acme.example' });
  });

  it('ignores an owner sent in the body', async () => {
    const response = await create(alice.cookie, {
      name: 'Acme',
      websiteUrl: 'https://acme.example',
      userId: bob.user.id,
    });
    const [row] = await context.db
      .select()
      .from(clients)
      .where(eq(clients.id, response.json<{ id: string }>().id));
    expect(row?.userId).toBe(alice.user.id);
  });

  it.each([
    ['acme.example', 'invalid_url'],
    ['ftp://acme.example', 'invalid_url'],
    ['javascript:alert(1)', 'invalid_url'],
    ['http://localhost:3000', 'invalid_url'],
    ['http://169.254.169.254/latest/', 'blocked_host'],
    ['http://10.0.0.5/', 'blocked_host'],
  ])('rejects %s with %s on the websiteUrl field', async (websiteUrl, code) => {
    const response = await create(alice.cookie, { name: 'Bad', websiteUrl });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code, details: { issues: [{ path: 'body.websiteUrl' }] } },
    });
    expect(context.enqueued).toEqual([]);
  });

  it('rejects a missing name', async () => {
    const response = await create(alice.cookie, { name: '  ', websiteUrl: 'https://acme.example' });
    expect(response.json()).toMatchObject({
      error: { code: 'validation_error', details: { issues: [{ path: 'body.name' }] } },
    });
  });

  it('rejects the same site twice for one user, however it is spelled', async () => {
    const first = await create(alice.cookie, { name: 'Acme', websiteUrl: 'https://acme.example' });
    const again = await create(alice.cookie, {
      name: 'Acme again',
      websiteUrl: 'http://WWW.acme.example/',
    });

    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({
      error: { code: 'duplicate_site', details: { clientId: first.json<{ id: string }>().id } },
    });
  });

  it('lets two users track the same site independently', async () => {
    expect(
      (await create(alice.cookie, { name: 'Acme', websiteUrl: 'https://acme.example' })).statusCode,
    ).toBe(202);
    expect(
      (await create(bob.cookie, { name: 'Acme', websiteUrl: 'https://acme.example' })).statusCode,
    ).toBe(202);
  });

  it('lets only one of two simultaneous requests for the same site through', async () => {
    const responses = await Promise.all([
      create(alice.cookie, { name: 'One', websiteUrl: 'https://acme.example' }),
      create(alice.cookie, { name: 'Two', websiteUrl: 'https://www.acme.example' }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 409]);
  });
});

describe('GET /api/clients/:id and POST /api/clients/:id/recrawl', () => {
  const get = (cookie: string, url: string, method: 'GET' | 'POST' = 'GET') =>
    context.app.inject({ method, url, headers: { cookie } });

  it("hides another user's client behind 404", async () => {
    const { id } = (
      await create(alice.cookie, { name: 'Acme', websiteUrl: 'https://acme.example' })
    ).json<{ id: string }>();
    expect((await get(alice.cookie, `/api/clients/${id}`)).statusCode).toBe(200);
    expect((await get(bob.cookie, `/api/clients/${id}`)).statusCode).toBe(404);
    expect((await get(bob.cookie, `/api/clients/${id}/recrawl`, 'POST')).statusCode).toBe(404);
    expect((await get(alice.cookie, '/api/clients/nope')).statusCode).toBe(404);
  });

  it('re-crawls a finished client but not one that is still running', async () => {
    const { id } = (
      await create(alice.cookie, { name: 'Acme', websiteUrl: 'https://acme.example' })
    ).json<{ id: string }>();
    expect((await get(alice.cookie, `/api/clients/${id}/recrawl`, 'POST')).statusCode).toBe(409);

    await context.db
      .update(clients)
      .set({ crawlStatus: 'failed', crawlErrorCode: 'no_sitemap' })
      .where(eq(clients.id, id));
    const retry = await get(alice.cookie, `/api/clients/${id}/recrawl`, 'POST');
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({ crawlStatus: 'pending', crawlErrorCode: null });
    expect(context.enqueued).toEqual([id, id]);
  });
});
