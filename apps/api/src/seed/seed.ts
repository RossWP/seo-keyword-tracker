import { and, count, eq } from 'drizzle-orm';
import { pino } from 'pino';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { BOT_USER_AGENT } from '../crawler/bot.js';
import { crawlClient } from '../crawler/crawl-job.js';
import { createFetcher } from '../crawler/fetcher.js';
import { createDb, type Database } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { clients, pageKeywords, pages } from '../db/schema.js';
import { createPool } from '../lib/db.js';
import { hashPassword } from '../lib/passwords.js';
import { parseWebsiteUrl } from '../lib/url.js';
import { upsertUser } from '../modules/users/users.repository.js';
import { DEFAULT_DEMO_PASSWORD, DEMO_USERS } from './data.js';
import { historyDays, snapshotDates } from './rank-generator.js';
import { countSnapshots, fillSnapshots, loadPairs } from './snapshots.js';

const MIN_SNAPSHOTS = 50_000;

const seedEnv = z.object({
  NODE_ENV: z.string().default('development'),
  SEED_PASSWORD: z.string().min(8).default(DEFAULT_DEMO_PASSWORD),
});

const env = seedEnv.parse(process.env);
const recrawl = process.argv.includes('--recrawl');
const log = pino(env.NODE_ENV === 'production' ? {} : { transport: { target: 'pino-pretty' } });
const pool = createPool(loadConfig().databaseUrl);
const db = createDb(pool);

try {
  await runMigrations(db);

  // 1. Demo users (re-running updates the password instead of duplicating them).
  const passwordHash = await hashPassword(env.SEED_PASSWORD);
  const userIds = new Map<string, string>();
  for (const { email } of DEMO_USERS) {
    userIds.set(email, (await upsertUser(db, { email, passwordHash })).id);
  }

  // 2. One client each, crawled with the same code path as "Add client" in the app.
  const fetcher = createFetcher({ userAgent: BOT_USER_AGENT });
  const demoClients: { id: string; name: string }[] = [];
  for (const { email, client } of DEMO_USERS) {
    const id = await ensureClient(db, userIds.get(email) ?? '', client);
    demoClients.push({ id, name: client.name });
    const [current] = await db.select().from(clients).where(eq(clients.id, id));
    const crawled = current?.crawlStatus === 'done' || current?.crawlStatus === 'partial';
    if (crawled && !recrawl) {
      log.info({ client: client.name }, 'already crawled, skipping (use --recrawl to refresh)');
      continue;
    }
    log.info({ client: client.name, url: client.websiteUrl }, 'crawling (about a minute per site)');
    await db.update(clients).set({ crawlStatus: 'pending' }).where(eq(clients.id, id));
    await crawlClient(id, { db, fetcher, now: () => new Date(), log });
    await logCrawlSummary(db, id, client.name);
  }

  // Both demo accounts must have something to show; 50k rows from one client alone would hide
  // a failed crawl of the other.
  for (const { id, name } of demoClients) {
    if ((await countClientKeywords(db, id)) === 0) {
      const [client] = await db.select().from(clients).where(eq(clients.id, id));
      throw new Error(
        `${name} has no keywords (crawl ${client?.crawlStatus ?? 'missing'}: ${client?.crawlErrorMessage ?? 'no pages analysed'}). ` +
          'Check the site is reachable and run `pnpm seed --recrawl`.',
      );
    }
  }

  // 3. Rank history for every page–keyword pair of every user, including clients added in the app.
  const pairs = await loadPairs(db);
  if (pairs.length === 0) {
    throw new Error(
      'No keywords were extracted, so there is nothing to track. Check the crawl errors above.',
    );
  }
  const days = historyDays(pairs.length, MIN_SNAPSHOTS);
  const inserted = await fillSnapshots(db, pairs, snapshotDates(new Date(), days));
  const total = await countSnapshots(db);
  log.info({ pairs: pairs.length, days, inserted, total }, 'rank snapshots ready');
  if (total < MIN_SNAPSHOTS) {
    throw new Error(`Only ${total} snapshots exist; expected at least ${MIN_SNAPSHOTS}`);
  }

  console.log(
    '\nSeed complete. Sign in at http://localhost:5173 (dev) or http://localhost:8080 (Docker) with:',
  );
  for (const { email } of DEMO_USERS) console.log(`  ${email} / ${env.SEED_PASSWORD}`);
} catch (error) {
  log.error({ err: error }, 'seed failed');
  process.exitCode = 1;
} finally {
  await pool.end();
  log.flush();
}

async function ensureClient(
  database: Database,
  userId: string,
  client: { name: string; websiteUrl: string },
): Promise<string> {
  const website = parseWebsiteUrl(client.websiteUrl);
  if (!website) throw new Error(`Invalid seed URL ${client.websiteUrl}`);
  await database
    .insert(clients)
    .values({ userId, name: client.name, websiteUrl: website.url, siteKey: website.siteKey })
    .onConflictDoNothing();
  const [row] = await database
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.userId, userId), eq(clients.siteKey, website.siteKey)));
  if (!row) throw new Error(`Client ${client.name} was not created`);
  return row.id;
}

async function logCrawlSummary(database: Database, clientId: string, name: string): Promise<void> {
  const [client] = await database.select().from(clients).where(eq(clients.id, clientId));
  const rows = await database
    .select({ status: pages.fetchStatus })
    .from(pages)
    .where(eq(pages.clientId, clientId));
  const ok = rows.filter((row) => row.status === 'ok').length;
  const summary = {
    client: name,
    status: client?.crawlStatus,
    pagesOk: ok,
    pagesTotal: rows.length,
    sitemap: client?.sitemapUrl,
    error: client?.crawlErrorCode ?? undefined,
  };
  if (client?.crawlStatus === 'failed')
    log.warn(summary, `crawl failed: ${client.crawlErrorMessage ?? ''}`);
  else log.info(summary, 'crawl finished');
}

async function countClientKeywords(database: Database, clientId: string): Promise<number> {
  const [row] = await database
    .select({ total: count() })
    .from(pageKeywords)
    .innerJoin(pages, eq(pages.id, pageKeywords.pageId))
    .where(eq(pages.clientId, clientId));
  return row?.total ?? 0;
}
