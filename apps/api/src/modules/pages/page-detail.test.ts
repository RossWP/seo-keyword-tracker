import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext } from '../../test/context.js';
import { createClient, createPage, signedInUser } from '../../test/factories.js';

const context = createTestContext();
afterAll(() => context.close());

let alice: Awaited<ReturnType<typeof signedInUser>>;
let bob: Awaited<ReturnType<typeof signedInUser>>;
let pageId: string;

beforeEach(async () => {
  await context.reset();
  alice = await signedInUser(context, 'alice@agency.test');
  bob = await signedInUser(context, 'bob@agency.test');
  const client = await createClient(context, alice.user.id, {
    name: 'Semrush',
    siteKey: 'semrush.com',
  });
  const page = await createPage(context, client.id, {
    url: 'https://www.semrush.com/blog/keyword-research/',
    title: 'Keyword Research',
    keywords: [
      {
        term: 'keyword research',
        snapshots: [
          // One snapshot per UTC day. Toronto is UTC-4 until the DST change on Sun 2026-11-01,
          // then UTC-5, so near midnight the local day depends on the date's own offset.
          { capturedAt: '2026-10-07T02:30:00Z', position: 7 }, // Oct 6, 22:30 EDT
          { capturedAt: '2026-11-01T03:30:00Z', position: 6 }, // Oct 31, 23:30 EDT
          { capturedAt: '2026-11-02T04:30:00Z', position: null }, // Nov 1, 23:30 EST (not Nov 2)
          { capturedAt: '2026-11-03T05:30:00Z', position: 3 }, // Nov 3, 00:30 EST
        ],
      },
      { term: 'keyword tools' },
    ],
    issues: [
      { code: 'thin_content', severity: 'warning' },
      { code: 'h1_missing', severity: 'error' },
    ],
  });
  pageId = page.id;
});

const get = (cookie: string, url: string) =>
  context.app.inject({ method: 'GET', url, headers: { cookie } });

describe('GET /api/pages/:id', () => {
  it('returns the page with keywords, latest positions and issues errors-first', async () => {
    const response = await get(alice.cookie, `/api/pages/${pageId}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      title: 'Keyword Research',
      client: { name: 'Semrush' },
      keywords: [
        { term: 'keyword research', position: 3, date: '2026-11-03' },
        { term: 'keyword tools', position: null, date: null },
      ],
      issues: [{ code: 'h1_missing', severity: 'error' }, { code: 'thin_content' }],
    });
  });

  it("answers 404 for another user's page, an unknown id and a malformed id", async () => {
    expect((await get(bob.cookie, `/api/pages/${pageId}`)).statusCode).toBe(404);
    expect(
      (await get(alice.cookie, '/api/pages/00000000-0000-4000-8000-000000000000')).statusCode,
    ).toBe(404);
    expect((await get(alice.cookie, '/api/pages/123')).statusCode).toBe(404);
    expect((await get(bob.cookie, `/api/pages/${pageId}/rankings`)).statusCode).toBe(404);
  });
});

describe('GET /api/pages/:id/rankings', () => {
  const points = async (from: string, to: string) => {
    const response = await get(alice.cookie, `/api/pages/${pageId}/rankings?from=${from}&to=${to}`);
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      series: { term: string; points: { date: string; position: number | null }[] }[];
    }>();
    return body.series[0]?.points ?? [];
  };

  it('converts UTC snapshots to Toronto calendar days', async () => {
    // 02:30 UTC on Oct 7 is still Oct 6 in Toronto.
    expect(await points('2026-10-06', '2026-10-06')).toEqual([{ date: '2026-10-06', position: 7 }]);
    expect(await points('2026-10-07', '2026-10-07')).toEqual([]);
  });

  it('uses the offset of each date across the daylight saving change', async () => {
    expect(await points('2026-10-31', '2026-10-31')).toEqual([{ date: '2026-10-31', position: 6 }]);
    expect(await points('2026-11-01', '2026-11-01')).toEqual([
      { date: '2026-11-01', position: null },
    ]);
    expect(await points('2026-11-02', '2026-11-02')).toEqual([]);
    expect(await points('2026-10-31', '2026-11-03')).toHaveLength(3);
  });

  it('returns every keyword as a series, empty when it has no history', async () => {
    const response = await get(
      alice.cookie,
      `/api/pages/${pageId}/rankings?from=2026-10-01&to=2026-11-30`,
    );
    expect(response.json()).toMatchObject({
      timezone: 'America/Toronto',
      from: '2026-10-01',
      to: '2026-11-30',
      series: [{ term: 'keyword research' }, { term: 'keyword tools', points: [] }],
    });
  });

  it('defaults to the last 90 days', async () => {
    const body = (await get(alice.cookie, `/api/pages/${pageId}/rankings`)).json<{
      from: string;
      to: string;
    }>();
    expect((Date.parse(body.to) - Date.parse(body.from)) / 86_400_000).toBe(89);
  });

  it('rejects reversed, oversized and malformed ranges', async () => {
    const status = async (query: string) =>
      (await get(alice.cookie, `/api/pages/${pageId}/rankings?${query}`)).statusCode;
    expect(await status('from=2026-11-02&to=2026-11-01')).toBe(400);
    expect(await status('from=2020-01-01&to=2026-11-01')).toBe(400);
    expect(await status('from=2026-13-40&to=2026-11-01')).toBe(400);
  });
});
