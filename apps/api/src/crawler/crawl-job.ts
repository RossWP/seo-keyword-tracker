import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/client.js';
import { extractPage, type PageFacts } from './analyze/extract.js';
import { buildSiteContext, fetchFailureIssue, findIssues } from './analyze/issues.js';
import { extractKeywords } from './analyze/keywords.js';
import { BOT_TOKEN } from './bot.js';
import {
  claimCrawl,
  saveAnalysis,
  saveFetchFailure,
  updateClientCrawl,
  upsertPage,
  type PageRow,
} from './crawl.repository.js';
import { discoverBlog } from './discovery.js';
import { CrawlError } from './errors.js';
import { decodeBody, type Fetcher } from './fetcher.js';

export interface CrawlDeps {
  db: Database;
  fetcher: Fetcher;
  now: () => Date;
  log: FastifyBaseLogger;
  /** Pause between page requests when robots.txt sets no Crawl-delay. */
  defaultDelayMs?: number;
  /** Crawl-delay is honoured up to this; Semrush asks for 20 s, which would make 15 pages take 5 min. */
  maxDelayMs?: number;
  limit?: number;
}

const PAGE_MAX_BYTES = 5_000_000;
const HTML_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5';
/** Stop early when the site keeps refusing us; the rest would fail the same way. */
const MAX_CONSECUTIVE_BLOCKS = 3;

interface FetchedEntry {
  pageId: string;
  facts: PageFacts | null;
  failure: { status: number | null; reason: string } | null;
}

/**
 * Crawls one client end to end: discover the blog sitemap, fetch the first 15 posts politely,
 * then extract keywords and SEO issues. Progress and the outcome live on the client row, so
 * the UI can poll it and a restarted server can pick the crawl up again.
 */
export async function crawlClient(
  clientId: string,
  deps: CrawlDeps,
  signal?: AbortSignal,
): Promise<void> {
  const { db, now, log } = deps;
  const client = await claimCrawl(db, clientId, now());
  if (!client) return;
  const clientLog = log.child({ clientId, site: client.websiteUrl });

  try {
    const discovery = await discoverBlog(client.websiteUrl, {
      fetcher: deps.fetcher,
      robotsAgent: BOT_TOKEN,
      limit: deps.limit ?? 15,
    });
    clientLog.info(
      { sitemaps: discovery.sitemapUrls, posts: discovery.entries.length },
      'blog discovered',
    );
    await updateClientCrawl(db, clientId, {
      crawlStatus: 'crawling',
      sitemapUrl: discovery.sitemapUrls.join(' '),
      discoveryMethod: 'sitemap',
      pagesTotal: discovery.entries.length,
      crawlHeartbeatAt: now(),
    });

    const delayMs = Math.min(
      discovery.crawlDelaySeconds === null
        ? (deps.defaultDelayMs ?? 1_000)
        : discovery.crawlDelaySeconds * 1_000,
      deps.maxDelayMs ?? 5_000,
    );
    const fetched: FetchedEntry[] = [];
    let consecutiveBlocks = 0;
    let requests = 0;
    let stoppedEarly = false;

    for (const [index, entry] of discovery.entries.entries()) {
      if (signal?.aborted) {
        // Shutting down: hand the crawl back so the next start resumes it from the top.
        await updateClientCrawl(db, clientId, { crawlStatus: 'pending', crawlHeartbeatAt: null });
        clientLog.info({ pagesDone: index }, 'crawl interrupted by shutdown, will resume');
        return;
      }
      const base = { clientId, url: entry.url, sitemapPosition: index + 1, fetchedAt: now() };
      if (!entry.allowedByRobots) {
        const pageId = await upsertPage(db, {
          ...base,
          fetchStatus: 'skipped_robots',
          fetchError: 'Disallowed by robots.txt',
        });
        fetched.push({ pageId, facts: null, failure: null });
      } else if (stoppedEarly) {
        const pageId = await upsertPage(db, {
          ...base,
          fetchStatus: 'blocked',
          fetchError: 'Not fetched: the site kept refusing the crawler',
        });
        fetched.push({
          pageId,
          facts: null,
          failure: { status: null, reason: 'blocked by the site' },
        });
      } else {
        if (requests > 0) await sleep(delayMs, undefined, { signal }).catch(() => undefined);
        requests++;
        const result = await fetchPage(entry.url, deps.fetcher);
        const pageId = await upsertPage(db, { ...base, ...result.row, fetchedAt: now() });
        fetched.push({ pageId, facts: result.facts, failure: result.failure });
        consecutiveBlocks = result.row.fetchStatus === 'blocked' ? consecutiveBlocks + 1 : 0;
        stoppedEarly = consecutiveBlocks >= MAX_CONSECUTIVE_BLOCKS;
      }
      await updateClientCrawl(db, clientId, { pagesDone: index + 1, crawlHeartbeatAt: now() });
    }

    // Keywords and duplicate titles are judged across all pages of the client, so analysis runs last.
    const analysed = fetched.filter(
      (item): item is FetchedEntry & { facts: PageFacts } => item.facts !== null,
    );
    const allFacts = analysed.map((item) => item.facts);
    const keywordPicks = extractKeywords(allFacts);
    const site = buildSiteContext(allFacts);
    for (const [index, item] of analysed.entries()) {
      await saveAnalysis(db, item.pageId, keywordPicks[index] ?? [], findIssues(item.facts, site));
    }
    for (const item of fetched) {
      if (item.failure)
        await saveFetchFailure(
          db,
          item.pageId,
          fetchFailureIssue(item.failure.status, item.failure.reason),
        );
    }

    const complete = analysed.length === fetched.length;
    await updateClientCrawl(db, clientId, {
      crawlStatus: complete ? 'done' : 'partial',
      crawlErrorCode: stoppedEarly ? 'blocked_by_site' : null,
      crawlErrorMessage: complete
        ? null
        : `${fetched.length - analysed.length} of ${fetched.length} pages could not be analysed`,
      crawlFinishedAt: now(),
    });
    clientLog.info({ analysed: analysed.length, total: fetched.length }, 'crawl finished');
  } catch (error) {
    const known = error instanceof CrawlError;
    if (!known) clientLog.error({ err: error }, 'crawl crashed');
    else clientLog.warn({ code: error.code, reason: error.message }, 'crawl failed');
    await updateClientCrawl(db, clientId, {
      crawlStatus: 'failed',
      crawlErrorCode: known ? error.code : 'internal_error',
      crawlErrorMessage: known ? error.message : 'Unexpected error while crawling',
      crawlFinishedAt: now(),
    });
  }
}

interface PageFetch {
  row: Omit<PageRow, 'clientId' | 'url' | 'sitemapPosition' | 'fetchedAt'>;
  facts: PageFacts | null;
  failure: FetchedEntry['failure'];
}

async function fetchPage(url: string, fetcher: Fetcher): Promise<PageFetch> {
  try {
    const page = await fetcher.fetch(url, { accept: HTML_ACCEPT, maxBytes: PAGE_MAX_BYTES });
    const common = { httpStatus: page.status, finalUrl: page.url, responseMs: page.elapsedMs };
    if (page.status === 403 || page.status === 429 || page.headers.get('cf-mitigated')) {
      return {
        row: {
          ...common,
          fetchStatus: 'blocked',
          fetchError: `The site refused the crawler (HTTP ${page.status})`,
        },
        facts: null,
        failure: { status: page.status, reason: 'refused' },
      };
    }
    if (page.status >= 400) {
      return {
        row: { ...common, fetchStatus: 'failed', fetchError: `HTTP ${page.status}` },
        facts: null,
        failure: { status: page.status, reason: `HTTP ${page.status}` },
      };
    }
    if (!/html/i.test(page.contentType)) {
      const reason = `Not an HTML page (${page.contentType || 'no content type'})`;
      return {
        row: { ...common, fetchStatus: 'failed', fetchError: reason },
        facts: null,
        failure: { status: null, reason },
      };
    }
    const facts = extractPage(
      decodeBody(page.body, page.contentType),
      page.url,
      page.headers.get('x-robots-tag'),
    );
    return {
      row: {
        ...common,
        fetchStatus: 'ok',
        fetchError: null,
        title: facts.title,
        metaDescription: facts.metaDescription,
        h1: facts.h1s[0] ?? null,
        wordCount: facts.wordCount,
        lang: facts.lang,
      },
      facts,
      failure: null,
    };
  } catch (error) {
    if (!(error instanceof CrawlError)) throw error;
    return {
      row: { fetchStatus: 'failed', fetchError: error.message },
      facts: null,
      failure: { status: null, reason: error.message },
    };
  }
}
