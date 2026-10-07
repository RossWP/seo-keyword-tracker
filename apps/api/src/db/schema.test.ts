import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../test/database.js';
import { createDb } from './client.js';
import { clients, keywords, pageKeywords, pages, rankSnapshots, users } from './schema.js';

const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 2 });
const db = createDb(pool);

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await db.execute(sql`truncate users, keywords restart identity cascade`);
});

async function createUser(email = 'alice@agency.test') {
  const [user] = await db.insert(users).values({ email, passwordHash: 'hash' }).returning();
  if (!user) throw new Error('user not created');
  return user;
}

async function createClient(userId: string, siteKey = 'yoast.com') {
  const [client] = await db
    .insert(clients)
    .values({ userId, name: 'Yoast', websiteUrl: `https://${siteKey}`, siteKey })
    .returning();
  if (!client) throw new Error('client not created');
  return client;
}

async function createPageKeyword(clientId: string) {
  const [page] = await db
    .insert(pages)
    .values({
      clientId,
      url: 'https://yoast.com/what-is-seo/',
      sitemapPosition: 1,
      fetchStatus: 'ok',
      fetchedAt: new Date(),
    })
    .returning();
  const [keyword] = await db.insert(keywords).values({ term: 'what is seo' }).returning();
  if (!page || !keyword) throw new Error('fixtures not created');
  const [pair] = await db
    .insert(pageKeywords)
    .values({ pageId: page.id, keywordId: keyword.id, score: 9.5, rankOrder: 1 })
    .returning();
  if (!pair) throw new Error('page keyword not created');
  return { page, pair };
}

/** Postgres error code of a rejected query (drizzle wraps the driver error in `cause`). */
async function pgErrorCode(query: Promise<unknown>): Promise<string | undefined> {
  try {
    await query;
  } catch (error) {
    const cause = error instanceof Error && 'cause' in error ? error.cause : error;
    if (cause && typeof cause === 'object' && 'code' in cause) return String(cause.code);
  }
  return undefined;
}

describe('database schema', () => {
  it('enables pg_trgm for search indexes', async () => {
    const result = await db.execute(sql`select 1 from pg_extension where extname = 'pg_trgm'`);
    expect(result.rowCount).toBe(1);
  });

  it('rejects emails that are not lowercased', async () => {
    const code = await pgErrorCode(
      db.insert(users).values({ email: 'Alice@Agency.test', passwordHash: 'hash' }),
    );
    expect(code).toBe('23514'); // check_violation
  });

  it('allows a site once per user, but for different users independently', async () => {
    const alice = await createUser();
    const bob = await createUser('bob@agency.test');
    await createClient(alice.id);

    expect(await pgErrorCode(createClient(alice.id))).toBe('23505'); // unique_violation
    await expect(createClient(bob.id)).resolves.toMatchObject({ userId: bob.id });
  });

  it('keeps one snapshot per pair per day with positions 1–100 or null', async () => {
    const client = await createClient((await createUser()).id);
    const { pair } = await createPageKeyword(client.id);
    const snapshot = {
      pageKeywordId: pair.id,
      snapshotDate: '2026-10-07',
      capturedAt: new Date('2026-10-07T02:30:00Z'),
    };

    await db.insert(rankSnapshots).values({ ...snapshot, position: 12 });
    expect(await pgErrorCode(db.insert(rankSnapshots).values({ ...snapshot, position: 9 }))).toBe(
      '23505',
    );
    expect(
      await pgErrorCode(
        db.insert(rankSnapshots).values({ ...snapshot, snapshotDate: '2026-10-08', position: 101 }),
      ),
    ).toBe('23514');
    await db
      .insert(rankSnapshots)
      .values({ ...snapshot, snapshotDate: '2026-10-08', position: null });
  });

  it('removes pages, keywords pairs and snapshots when a client is deleted', async () => {
    const client = await createClient((await createUser()).id);
    const { pair } = await createPageKeyword(client.id);
    await db.insert(rankSnapshots).values({
      pageKeywordId: pair.id,
      snapshotDate: '2026-10-07',
      capturedAt: new Date('2026-10-07T02:30:00Z'),
      position: 5,
    });

    await db.delete(clients).where(eq(clients.id, client.id));

    expect(await db.select().from(pages)).toHaveLength(0);
    expect(await db.select().from(rankSnapshots)).toHaveLength(0);
    // The keyword dictionary is shared, so the term itself stays.
    expect(await db.select().from(keywords)).toHaveLength(1);
  });
});
