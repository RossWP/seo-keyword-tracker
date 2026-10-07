import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { clients } from '../../db/schema.js';

const clientColumns = {
  id: clients.id,
  name: clients.name,
  websiteUrl: clients.websiteUrl,
  crawlStatus: clients.crawlStatus,
  crawlErrorCode: clients.crawlErrorCode,
  crawlErrorMessage: clients.crawlErrorMessage,
  pagesTotal: clients.pagesTotal,
  pagesDone: clients.pagesDone,
  sitemapUrl: clients.sitemapUrl,
  createdAt: clients.createdAt,
  crawlFinishedAt: clients.crawlFinishedAt,
};

export type ClientSummary = Awaited<ReturnType<typeof listClients>>[number];

export function listClients(db: Database, userId: string) {
  return db
    .select(clientColumns)
    .from(clients)
    .where(eq(clients.userId, userId))
    .orderBy(asc(clients.name), asc(clients.createdAt));
}

/** Ownership is part of the lookup: another user's client is simply not found. */
export async function findOwnClient(db: Database, userId: string, clientId: string) {
  const [client] = await db
    .select(clientColumns)
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.userId, userId)));
  return client;
}

/** Inserts unless the user already has this site; returns undefined for a duplicate. */
export async function insertClient(
  db: Database,
  values: { userId: string; name: string; websiteUrl: string; siteKey: string },
) {
  const [client] = await db
    .insert(clients)
    .values(values)
    .onConflictDoNothing({ target: [clients.userId, clients.siteKey] })
    .returning(clientColumns);
  return client;
}

export async function findClientBySiteKey(db: Database, userId: string, siteKey: string) {
  const [client] = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(and(eq(clients.userId, userId), eq(clients.siteKey, siteKey)));
  return client;
}

/** Back to "pending" only from a finished state: a running crawl is never restarted twice. */
export async function requeueClient(db: Database, userId: string, clientId: string) {
  const [client] = await db
    .update(clients)
    .set({ crawlStatus: 'pending', crawlErrorCode: null, crawlErrorMessage: null })
    .where(
      and(
        eq(clients.id, clientId),
        eq(clients.userId, userId),
        inArray(clients.crawlStatus, ['done', 'partial', 'failed']),
      ),
    )
    .returning(clientColumns);
  return client;
}
