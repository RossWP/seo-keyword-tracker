import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { clients, keywords, pageKeywords, pages, users } from '../db/schema.js';
import { createTestContext } from '../test/context.js';
import { snapshotDates } from './rank-generator.js';
import { countSnapshots, fillSnapshots, loadPairs } from './snapshots.js';

const context = createTestContext();
afterAll(() => context.close());
beforeEach(() => context.reset());

async function createPairs(count: number) {
  const [user] = await context.db
    .insert(users)
    .values({ email: 'a@agency.test', passwordHash: 'x' })
    .returning();
  const [client] = await context.db
    .insert(clients)
    .values({
      userId: user?.id ?? '',
      name: 'A',
      websiteUrl: 'https://a.example/',
      siteKey: 'a.example',
    })
    .returning();
  const [page] = await context.db
    .insert(pages)
    .values({
      clientId: client?.id ?? '',
      url: 'https://a.example/post/',
      sitemapPosition: 1,
      fetchStatus: 'ok',
      fetchedAt: new Date(),
    })
    .returning();
  for (let i = 0; i < count; i++) {
    const [keyword] = await context.db
      .insert(keywords)
      .values({ term: `term ${i}` })
      .returning();
    await context.db
      .insert(pageKeywords)
      .values({ pageId: page?.id ?? '', keywordId: keyword?.id ?? 0, score: 1, rankOrder: i + 1 });
  }
}

describe('fillSnapshots', () => {
  it('inserts one row per pair per day, and re-running only adds missing days', async () => {
    await createPairs(3);
    const pairs = await loadPairs(context.db);
    const today = new Date('2026-10-07T12:00:00Z');

    expect(await fillSnapshots(context.db, pairs, snapshotDates(today, 400))).toBe(1_200);
    expect(await fillSnapshots(context.db, pairs, snapshotDates(today, 400))).toBe(0);

    const tomorrow = new Date('2026-10-08T12:00:00Z');
    expect(await fillSnapshots(context.db, pairs, snapshotDates(tomorrow, 400))).toBe(3);
    expect(await countSnapshots(context.db)).toBe(1_203);
  });

  it('handles batches larger than one insert', async () => {
    await createPairs(30);
    const pairs = await loadPairs(context.db);
    expect(await fillSnapshots(context.db, pairs, snapshotDates(new Date(), 365))).toBe(10_950);
  });
});
