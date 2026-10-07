import { and, eq, inArray, lt, notInArray, or, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { clients, keywords, pageKeywords, pages, seoIssues } from '../db/schema.js';
import type { KeywordPick } from './analyze/keywords.js';
import type { SeoIssue } from './analyze/issues.js';

type ClientUpdate = Partial<typeof clients.$inferInsert>;
export type PageRow = typeof pages.$inferInsert;

/** Atomic claim: only one runner can move a pending crawl to "discovering". */
export async function claimCrawl(db: Database, clientId: string, now: Date) {
  const [client] = await db
    .update(clients)
    .set({
      crawlStatus: 'discovering',
      crawlStartedAt: now,
      crawlHeartbeatAt: now,
      crawlFinishedAt: null,
      crawlErrorCode: null,
      crawlErrorMessage: null,
      pagesTotal: 0,
      pagesDone: 0,
    })
    .where(and(eq(clients.id, clientId), eq(clients.crawlStatus, 'pending')))
    .returning({ id: clients.id, websiteUrl: clients.websiteUrl });
  return client;
}

export async function updateClientCrawl(db: Database, clientId: string, values: ClientUpdate) {
  await db.update(clients).set(values).where(eq(clients.id, clientId));
}

export async function upsertPage(db: Database, page: PageRow): Promise<string> {
  const [row] = await db
    .insert(pages)
    .values(page)
    .onConflictDoUpdate({ target: [pages.clientId, pages.url], set: { ...page } })
    .returning({ id: pages.id });
  if (!row) throw new Error(`Failed to save page ${page.url}`);
  return row.id;
}

/**
 * Replaces a successfully fetched page's keywords and issues in one transaction. Keyword pairs
 * that survive a re-crawl are updated in place, so their rank history is kept.
 */
export async function saveAnalysis(
  db: Database,
  pageId: string,
  picks: KeywordPick[],
  issues: SeoIssue[],
): Promise<void> {
  await db.transaction(async (tx) => {
    const keywordIds: number[] = [];
    if (picks.length > 0) {
      await tx
        .insert(keywords)
        // Sorted, so concurrent crawls lock shared keyword rows in the same order (no deadlock).
        .values(
          picks
            .map(({ term }) => term)
            .sort()
            .map((term) => ({ term })),
        )
        .onConflictDoNothing();
      const rows = await tx
        .select({ id: keywords.id, term: keywords.term })
        .from(keywords)
        .where(
          inArray(
            keywords.term,
            picks.map(({ term }) => term),
          ),
        );
      const idByTerm = new Map(rows.map((row) => [row.term, row.id]));

      for (const [index, pick] of picks.entries()) {
        const keywordId = idByTerm.get(pick.term);
        if (keywordId === undefined) continue;
        keywordIds.push(keywordId);
        const values = { score: pick.score, rankOrder: index + 1, sources: pick.sources };
        await tx
          .insert(pageKeywords)
          .values({ pageId, keywordId, ...values })
          .onConflictDoUpdate({
            target: [pageKeywords.pageId, pageKeywords.keywordId],
            set: values,
          });
      }
    }
    await tx
      .delete(pageKeywords)
      .where(
        keywordIds.length > 0
          ? and(eq(pageKeywords.pageId, pageId), notInArray(pageKeywords.keywordId, keywordIds))
          : eq(pageKeywords.pageId, pageId),
      );

    await writeIssues(tx, pageId, issues);
  });
}

/**
 * A page that could not be fetched this time: only its issues are replaced. Its keywords stay,
 * because deleting them would cascade to their rank history over a temporary outage.
 */
export async function saveFetchFailure(db: Database, pageId: string, issue: SeoIssue) {
  await db.transaction((tx) => writeIssues(tx, pageId, [issue]));
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

async function writeIssues(tx: Transaction, pageId: string, issues: SeoIssue[]) {
  await tx.delete(seoIssues).where(eq(seoIssues.pageId, pageId));
  if (issues.length === 0) return;
  await tx.insert(seoIssues).values(
    issues.map((found) => ({
      pageId,
      code: found.code,
      severity: found.severity,
      message: found.message,
      details: found.details ?? null,
    })),
  );
}

/**
 * Crawls left "discovering"/"crawling" by a stopped process go back to "pending" so they run
 * again; a recent heartbeat means another live process still owns them.
 */
export async function requeueStaleCrawls(db: Database, staleBefore: Date): Promise<string[]> {
  await db
    .update(clients)
    .set({ crawlStatus: 'pending' })
    .where(
      and(
        inArray(clients.crawlStatus, ['discovering', 'crawling']),
        or(isNull(clients.crawlHeartbeatAt), lt(clients.crawlHeartbeatAt, staleBefore)),
      ),
    );
  const rows = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.crawlStatus, 'pending'))
    .orderBy(sql`${clients.createdAt} asc`);
  return rows.map((row) => row.id);
}
