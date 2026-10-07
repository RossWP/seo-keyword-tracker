import { and, asc, eq } from 'drizzle-orm';
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
