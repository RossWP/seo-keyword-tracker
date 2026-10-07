import { eq } from 'drizzle-orm';
import { clients, keywords, pageKeywords, pages, rankSnapshots, seoIssues } from '../db/schema.js';
import { hashPassword } from '../lib/passwords.js';
import { upsertUser } from '../modules/users/users.repository.js';
import type { TestContext } from './context.js';

const PASSWORD = 'test-password';
let passwordHash: Promise<string> | undefined;

/** Creates (or reuses) a user and returns a signed-in session cookie for it. */
export async function signedInUser(context: TestContext, email: string) {
  passwordHash ??= hashPassword(PASSWORD);
  const user = await upsertUser(context.db, { email, passwordHash: await passwordHash });
  const response = await context.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: PASSWORD },
  });
  const cookie = response.cookies.find((c) => c.name === 'sid');
  if (!cookie) throw new Error(`Login failed for ${email}: ${response.body}`);
  return { user, cookie: `sid=${cookie.value}` };
}

export async function createClient(
  context: TestContext,
  userId: string,
  values: {
    name: string;
    siteKey: string;
    crawlStatus?: (typeof clients.$inferInsert)['crawlStatus'];
  },
) {
  const [client] = await context.db
    .insert(clients)
    .values({ userId, websiteUrl: `https://${values.siteKey}/`, ...values })
    .returning();
  if (!client) throw new Error('client not created');
  return client;
}

interface PageSpec {
  url: string;
  title?: string;
  position?: number;
  keywords?: { term: string; snapshots?: { capturedAt: string; position: number | null }[] }[];
  issues?: { code: string; severity: 'error' | 'warning' }[];
}

export async function createPage(context: TestContext, clientId: string, spec: PageSpec) {
  const [page] = await context.db
    .insert(pages)
    .values({
      clientId,
      url: spec.url,
      title: spec.title ?? null,
      sitemapPosition: spec.position ?? 1,
      fetchStatus: 'ok',
      fetchedAt: new Date('2026-10-01T00:00:00Z'),
    })
    .returning();
  if (!page) throw new Error('page not created');

  for (const [index, keyword] of (spec.keywords ?? []).entries()) {
    await context.db.insert(keywords).values({ term: keyword.term }).onConflictDoNothing();
    const [row] = await context.db.select().from(keywords).where(eq(keywords.term, keyword.term));
    const [pair] = await context.db
      .insert(pageKeywords)
      .values({ pageId: page.id, keywordId: row?.id ?? 0, score: 10 - index, rankOrder: index + 1 })
      .returning();
    for (const snapshot of keyword.snapshots ?? []) {
      await context.db.insert(rankSnapshots).values({
        pageKeywordId: pair?.id ?? 0,
        snapshotDate: snapshot.capturedAt.slice(0, 10),
        capturedAt: new Date(snapshot.capturedAt),
        position: snapshot.position,
      });
    }
  }
  for (const found of spec.issues ?? []) {
    await context.db.insert(seoIssues).values({ pageId: page.id, ...found, message: found.code });
  }
  return page;
}
