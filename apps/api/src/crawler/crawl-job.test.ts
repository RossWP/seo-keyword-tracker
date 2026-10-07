import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clients, keywords, pageKeywords, pages, seoIssues, users } from '../db/schema.js';
import { createTestContext } from '../test/context.js';
import { startFixtureServer, type FixtureRoute } from '../test/fixture-server.js';
import { crawlClient, type CrawlDeps } from './crawl-job.js';
import { createCrawlRunner } from './crawl-runner.js';
import { requeueStaleCrawls } from './crawl.repository.js';
import { createFetcher } from './fetcher.js';

const context = createTestContext();
const servers: { close(): Promise<void> }[] = [];
afterAll(() => context.close());
beforeEach(() => context.reset());
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const article = (title: string, topic: string) => ({
  body: `<html lang="en"><head><title>${title} | Acme</title><meta name="description" content="About ${topic}."></head>
  <body><main><article><h1>${title}</h1><p>${`${topic} explained step by step. Why ${topic} matters for every site. `.repeat(30)}</p></article></main></body></html>`,
});

async function blogSite(extra: Record<string, FixtureRoute> = {}) {
  const routes: Record<string, FixtureRoute> = {};
  const server = await startFixtureServer(routes);
  const { origin } = server;
  const posts = [
    'keyword-research-basics',
    'link-building-guide',
    'missing-post',
    'private-roadmap',
  ];
  Object.assign(routes, {
    '/': { body: '<nav><a href="/blog/">Blog</a></nav>' },
    '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /blog/private-' },
    '/sitemap.xml': {
      type: 'application/xml',
      body: `<urlset>${posts.map((slug) => `<url><loc>${origin}/blog/${slug}/</loc></url>`).join('')}</urlset>`,
    },
    '/blog/keyword-research-basics/': article('Keyword Research Basics', 'keyword research'),
    '/blog/link-building-guide/': article('Link Building Guide', 'link building'),
    ...extra,
  });
  servers.push(server);
  return server;
}

function deps(): CrawlDeps {
  return {
    db: context.db,
    fetcher: createFetcher({
      userAgent: 'test-bot',
      timeoutMs: 2_000,
      attempts: 1,
      allowPrivateNetworks: true,
    }),
    now: () => new Date(),
    log: context.app.log,
    defaultDelayMs: 0,
  };
}

async function createClient(websiteUrl: string) {
  const [user] = await context.db
    .insert(users)
    .values({ email: 'alice@agency.test', passwordHash: 'x' })
    .returning();
  const [client] = await context.db
    .insert(clients)
    .values({ userId: user?.id ?? '', name: 'Acme', websiteUrl, siteKey: new URL(websiteUrl).host })
    .returning();
  if (!client) throw new Error('client not created');
  return client;
}

const loadClient = async (id: string) =>
  (await context.db.select().from(clients).where(eq(clients.id, id)))[0];

describe('crawlClient', () => {
  it('crawls the blog, records every page and finishes as partial when some fail', async () => {
    const site = await blogSite();
    const client = await createClient(site.origin);

    await crawlClient(client.id, deps());

    const saved = await loadClient(client.id);
    expect(saved).toMatchObject({
      crawlStatus: 'partial',
      pagesTotal: 4,
      pagesDone: 4,
      sitemapUrl: `${site.origin}/sitemap.xml`,
      crawlErrorMessage: '2 of 4 pages could not be analysed',
    });

    const rows = await context.db.select().from(pages).orderBy(asc(pages.sitemapPosition));
    expect(rows.map((row) => [row.sitemapPosition, row.fetchStatus, row.httpStatus])).toEqual([
      [1, 'ok', 200],
      [2, 'ok', 200],
      [3, 'failed', 404],
      [4, 'skipped_robots', null],
    ]);
    expect(rows[0]).toMatchObject({
      title: 'Keyword Research Basics | Acme',
      h1: 'Keyword Research Basics',
    });

    const terms = await context.db
      .select({ term: keywords.term, pageId: pageKeywords.pageId, rank: pageKeywords.rankOrder })
      .from(pageKeywords)
      .innerJoin(keywords, eq(keywords.id, pageKeywords.keywordId))
      .where(eq(pageKeywords.rankOrder, 1));
    expect(terms.map((row) => row.term).sort()).toEqual(['keyword research', 'link building']);

    const issues = await context.db.select().from(seoIssues);
    expect(issues.find((found) => found.pageId === rows[2]?.id)).toMatchObject({
      code: 'http_error',
      severity: 'error',
    });
  });

  it('marks the client failed with an explainable code when no sitemap exists', async () => {
    const routes: Record<string, FixtureRoute> = { '/': { body: '<p>Hello</p>' } };
    const server = await startFixtureServer(routes);
    servers.push(server);
    const client = await createClient(server.origin);

    await crawlClient(client.id, deps());

    expect(await loadClient(client.id)).toMatchObject({
      crawlStatus: 'failed',
      crawlErrorCode: 'no_sitemap',
      pagesTotal: 0,
    });
  });

  it('does nothing for a crawl another runner already claimed', async () => {
    const site = await blogSite();
    const client = await createClient(site.origin);
    await context.db
      .update(clients)
      .set({ crawlStatus: 'crawling' })
      .where(eq(clients.id, client.id));

    await crawlClient(client.id, deps());

    expect(site.hits).toHaveLength(0);
  });

  it('keeps rank history for keywords that survive a re-crawl', async () => {
    const site = await blogSite();
    const client = await createClient(site.origin);
    await crawlClient(client.id, deps());
    const before = await context.db.select({ id: pageKeywords.id }).from(pageKeywords);

    await context.db
      .update(clients)
      .set({ crawlStatus: 'pending' })
      .where(eq(clients.id, client.id));
    await crawlClient(client.id, deps());

    const after = await context.db.select({ id: pageKeywords.id }).from(pageKeywords);
    expect(after.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort());
    expect(await context.db.select().from(pages)).toHaveLength(4);
  });
});

describe('crawl runner and restarts', () => {
  it('requeues crawls a stopped process left running, and the runner completes them', async () => {
    const site = await blogSite();
    const client = await createClient(site.origin);
    await context.db
      .update(clients)
      .set({ crawlStatus: 'crawling', crawlHeartbeatAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(clients.id, client.id));

    const ids = await requeueStaleCrawls(context.db, new Date(Date.now() - 2 * 60_000));
    expect(ids).toEqual([client.id]);

    const runner = createCrawlRunner({
      run: (id) => crawlClient(id, deps()),
      log: context.app.log,
    });
    for (const id of ids) runner.enqueue(id);
    runner.enqueue(client.id);
    await runner.idle();

    expect((await loadClient(client.id))?.crawlStatus).toBe('partial');
    expect(site.hits.filter((path) => path === '/sitemap.xml')).toHaveLength(1);
  });

  it('leaves a crawl with a recent heartbeat alone', async () => {
    const client = await createClient('https://example.com');
    await context.db
      .update(clients)
      .set({ crawlStatus: 'crawling', crawlHeartbeatAt: new Date() })
      .where(eq(clients.id, client.id));
    expect(await requeueStaleCrawls(context.db, new Date(Date.now() - 2 * 60_000))).toEqual([]);
  });
});

describe('shutdown', () => {
  it('hands an interrupted crawl back to pending', async () => {
    const site = await blogSite();
    const client = await createClient(site.origin);
    const controller = new AbortController();
    controller.abort();

    await crawlClient(client.id, deps(), controller.signal);

    expect(await loadClient(client.id)).toMatchObject({ crawlStatus: 'pending', pagesDone: 0 });
    expect(site.hits.some((path) => path.startsWith('/blog/'))).toBe(false);
  });
});
