import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext } from '../../test/context.js';
import { createClient, createPage, signedInUser } from '../../test/factories.js';

const context = createTestContext();
afterAll(() => context.close());

let alice: Awaited<ReturnType<typeof signedInUser>>;
let bob: Awaited<ReturnType<typeof signedInUser>>;
let aliceClientId: string;
let bobClientId: string;

beforeEach(async () => {
  await context.reset();
  alice = await signedInUser(context, 'alice@agency.test');
  bob = await signedInUser(context, 'bob@agency.test');

  const semrush = await createClient(context, alice.user.id, {
    name: 'Semrush',
    siteKey: 'semrush.com',
    crawlStatus: 'done',
  });
  aliceClientId = semrush.id;
  await createPage(context, semrush.id, {
    url: 'https://www.semrush.com/blog/keyword-research/',
    title: 'Keyword Research',
    position: 1,
    keywords: [
      {
        term: 'keyword research',
        snapshots: [
          { capturedAt: '2026-10-05T02:30:00Z', position: 9 },
          // 02:30 UTC on Oct 7 is the evening of Oct 6 in Toronto.
          { capturedAt: '2026-10-07T02:30:00Z', position: 4 },
        ],
      },
      { term: 'seo tools', snapshots: [{ capturedAt: '2026-10-07T02:30:00Z', position: null }] },
    ],
    issues: [
      { code: 'h1_missing', severity: 'error' },
      { code: 'thin_content', severity: 'warning' },
    ],
  });
  await createPage(context, semrush.id, {
    url: 'https://www.semrush.com/blog/100%-guide/',
    title: 'Guide',
    position: 2,
  });

  const yoast = await createClient(context, bob.user.id, {
    name: 'Yoast',
    siteKey: 'yoast.com',
    crawlStatus: 'done',
  });
  bobClientId = yoast.id;
  await createPage(context, yoast.id, {
    url: 'https://yoast.com/link-building/',
    keywords: [{ term: 'link building' }],
  });
});

const list = (cookie: string, query = '') =>
  context.app.inject({ method: 'GET', url: `/api/pages${query}`, headers: { cookie } });

describe('GET /api/pages', () => {
  it("lists only the signed-in user's pages, with latest positions and issue counts", async () => {
    const response = await list(alice.cookie);
    expect(response.statusCode).toBe(200);
    const body = response.json<{ total: number; items: Record<string, unknown>[] }>();

    expect(body.total).toBe(2);
    expect(body.items.map((item) => item.url)).toEqual([
      'https://www.semrush.com/blog/keyword-research/',
      'https://www.semrush.com/blog/100%-guide/',
    ]);
    expect(body.items[0]).toMatchObject({
      client: { name: 'Semrush' },
      issueCount: 2,
      errorCount: 1,
      bestPosition: 4,
      keywords: [
        { term: 'keyword research', position: 4, date: '2026-10-06' },
        { term: 'seo tools', position: null, date: '2026-10-06' },
      ],
    });
    expect(body.items[1]).toMatchObject({ keywords: [], bestPosition: null, issueCount: 0 });
  });

  it('searches by URL and by keyword, treating % and _ literally', async () => {
    const byUrl = await list(alice.cookie, '?q=keyword-research');
    expect(byUrl.json<{ total: number }>().total).toBe(1);

    const byKeyword = await list(alice.cookie, '?q=SEO%20tools');
    expect(byKeyword.json<{ items: { url: string }[] }>().items[0]?.url).toContain(
      'keyword-research',
    );

    const percent = await list(alice.cookie, `?q=${encodeURIComponent('100%')}`);
    expect(percent.json<{ total: number }>().total).toBe(1);
    const wildcard = await list(alice.cookie, `?q=${encodeURIComponent('%')}`);
    expect(wildcard.json<{ total: number }>().total).toBe(1);
  });

  it("never finds another user's pages through search", async () => {
    const response = await list(alice.cookie, '?q=link%20building');
    expect(response.json<{ total: number }>().total).toBe(0);
  });

  it('filters by own client and returns 404 for a foreign or malformed client id', async () => {
    expect(
      (await list(alice.cookie, `?clientId=${aliceClientId}`)).json<{ total: number }>().total,
    ).toBe(2);
    expect((await list(alice.cookie, `?clientId=${bobClientId}`)).statusCode).toBe(404);
    expect((await list(alice.cookie, '?clientId=not-a-uuid')).statusCode).toBe(404);
  });

  it('paginates with a real total and an empty page past the end', async () => {
    const first = await list(alice.cookie, '?pageSize=1&page=1');
    expect(first.json()).toMatchObject({
      total: 2,
      page: 1,
      pageSize: 1,
      items: [{ title: 'Keyword Research' }],
    });
    const past = await list(alice.cookie, '?pageSize=1&page=5');
    expect(past.json()).toMatchObject({ total: 2, items: [] });
  });

  it('rejects invalid paging parameters', async () => {
    expect((await list(alice.cookie, '?pageSize=500')).statusCode).toBe(400);
    expect((await list(alice.cookie, '?page=0')).statusCode).toBe(400);
  });

  it('requires a session', async () => {
    expect((await context.app.inject({ method: 'GET', url: '/api/pages' })).statusCode).toBe(401);
  });
});

describe('GET /api/clients', () => {
  it("returns only the user's own clients", async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/clients',
      headers: { cookie: bob.cookie },
    });
    expect(
      response.json<{ items: { name: string }[] }>().items.map((client) => client.name),
    ).toEqual(['Yoast']);
  });
});
