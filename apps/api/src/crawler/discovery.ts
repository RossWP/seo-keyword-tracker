import * as cheerio from 'cheerio';
import { isSameSite, normalizePageUrl } from '../lib/url.js';
import { CrawlError } from './errors.js';
import { decodeBody, type Fetcher } from './fetcher.js';
import { parseRobots } from './robots.js';
import { readSitemap, type SitemapDocument } from './sitemap.js';

export interface DiscoveredEntry {
  url: string;
  /** False when robots.txt disallows it: listed for transparency, never fetched. */
  allowedByRobots: boolean;
}

export interface BlogDiscovery {
  /** Site origin after redirects (e.g. http://yoast.com → https://yoast.com). */
  origin: string;
  hubUrl: string | null;
  /** The chosen blog sitemap(s), e.g. post-sitemap.xml + post-sitemap2.xml. */
  sitemapUrls: string[];
  /** The first `limit` blog posts in sitemap order. */
  entries: DiscoveredEntry[];
  crawlDelaySeconds: number | null;
}

export interface DiscoveryOptions {
  fetcher: Fetcher;
  /** Product token matched against robots.txt user-agent groups. */
  robotsAgent: string;
  limit?: number;
}

const HTML = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5';
const XML = 'application/xml,text/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5';
const PAGE_MAX_BYTES = 5_000_000;
const SITEMAP_MAX_BYTES = 50_000_000;
/** URLs read per candidate sitemap: enough to judge it and to find 15 posts after filtering. */
const SAMPLE_SIZE = 500;
const MAX_SITEMAP_FETCHES = 30;
const CANDIDATES_TO_SAMPLE = 6;
const MAX_INDEX_DEPTH = 3;

const CONVENTIONAL_SITEMAPS = [
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/sitemap-index.xml',
  '/wp-sitemap.xml',
  '/sitemap/',
  '/blog/sitemap.xml',
];
const BLOG_WORDS = ['blog', 'articles', 'insights', 'news', 'resources', 'journal', 'stories'];
const POSITIVE_TOKENS = new Set([
  'blog',
  'blogs',
  'post',
  'posts',
  'article',
  'articles',
  'news',
  'stories',
]);
const NEGATIVE_TOKENS = new Set([
  'page',
  'pages',
  'product',
  'products',
  'category',
  'categories',
  'tag',
  'tags',
  'author',
  'authors',
  'image',
  'images',
  'video',
  'videos',
  'event',
  'events',
  'kb',
  'docs',
  'help',
  'academy',
  'course',
  'courses',
  'careers',
  'jobs',
  'pricing',
  'static',
  'tools',
  'apps',
]);
const ARCHIVE_SEGMENTS = new Set([
  'category',
  'tag',
  'tags',
  'author',
  'authors',
  'topic',
  'topics',
  'search',
  'feed',
  'wp-json',
]);
const NON_HTML = /\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|mp3|xml|json|css|js|txt)$/i;

/**
 * Finds a site's blog sitemap from its URL alone and returns the first blog posts in sitemap
 * order. Nothing is site-specific: the blog hub linked from the homepage, sitemap names and
 * URL shapes are combined into a score (see docs/design.md, "How the blog sitemap is found").
 */
export async function discoverBlog(
  siteUrl: string,
  { fetcher, robotsAgent, limit = 15 }: DiscoveryOptions,
): Promise<BlogDiscovery> {
  const homepage = await fetchHomepage(siteUrl, fetcher);
  const origin = new URL(homepage.url).origin;
  const hubUrl = findBlogHub(homepage.html, homepage.url, siteUrl);

  const robotsUrl = `${origin}/robots.txt`;
  const robots = parseRobots(robotsUrl, await fetchRobots(robotsUrl, fetcher));
  const crawlDelay = robots.getCrawlDelay(robotsAgent) ?? robots.getCrawlDelay('*') ?? null;

  // robots.txt entries first; if none of them leads to blog posts (missing, broken, or an
  // index whose children are dead), the conventional locations get their turn.
  const sources = [
    { urls: robots.getSitemaps().filter((url) => isHttpUrl(url) && isSameSite(url, origin)) },
    { urls: CONVENTIONAL_SITEMAPS.map((path) => origin + path), firstOnly: true },
  ];
  let foundSitemap = false;
  let found: { family: Family; posts: string[] } | null = null;
  for (const source of sources) {
    const candidates = await collectCandidates(origin, source.urls, fetcher, source.firstOnly);
    if (candidates.size === 0) continue;
    foundSitemap = true;
    const [best] = await scoreFamilies(candidates, hubUrl, origin, fetcher);
    const posts = best
      ? selectPosts(await familyUrls(best, fetcher, limit), origin, hubUrl, limit)
      : [];
    if (best && posts.length > 0) {
      found = { family: best, posts };
      break;
    }
  }
  if (!foundSitemap) {
    throw new CrawlError(
      'no_sitemap',
      `No sitemap found: none listed in robots.txt works, and ${CONVENTIONAL_SITEMAPS.join(', ')} are missing`,
    );
  }
  if (!found) {
    throw new CrawlError('no_blog_found', 'Sitemaps were found, but none of them lists blog posts');
  }
  const { family: best, posts } = found;

  return {
    origin,
    hubUrl,
    sitemapUrls: best.members,
    entries: posts.map((url) => ({
      url,
      allowedByRobots: robots.isAllowed(url, robotsAgent) !== false,
    })),
    crawlDelaySeconds: crawlDelay,
  };
}

async function fetchHomepage(siteUrl: string, fetcher: Fetcher) {
  let page;
  try {
    page = await fetcher.fetch(siteUrl, { accept: HTML, maxBytes: PAGE_MAX_BYTES });
  } catch (error) {
    if (error instanceof CrawlError && error.code !== 'timeout') throw error;
    throw new CrawlError('site_unreachable', `${siteUrl} did not respond`, { cause: error });
  }
  if (page.status === 403 || page.status === 429) {
    throw new CrawlError('blocked_by_site', `${siteUrl} refused the crawler (HTTP ${page.status})`);
  }
  if (page.status >= 400) {
    throw new CrawlError('site_unreachable', `${siteUrl} answered HTTP ${page.status}`);
  }
  return { url: page.url, html: decodeBody(page.body, page.contentType) };
}

/** robots.txt is optional: missing or broken means "everything allowed". */
async function fetchRobots(url: string, fetcher: Fetcher): Promise<string> {
  try {
    const response = await fetcher.fetch(url, { accept: 'text/plain', maxBytes: 500_000 });
    if (response.status !== 200 || /html/i.test(response.contentType)) return '';
    return decodeBody(response.body, response.contentType);
  } catch {
    return '';
  }
}

/** The blog's landing page, as linked from the homepage ("Blog" in the nav), or the entered path. */
export function findBlogHub(html: string, pageUrl: string, enteredUrl: string): string | null {
  const entered = new URL(enteredUrl);
  if (entered.pathname !== '/' && entered.pathname !== '')
    return normalizePageUrl(entered.toString());

  const $ = cheerio.load(html);
  let best: { url: string; score: number } | null = null;
  $('a[href]').each((_index, element) => {
    const anchor = $(element);
    const url = normalizePageUrl(anchor.attr('href') ?? '', pageUrl);
    if (!url || !isSameSite(url, pageUrl) || new URL(url).pathname === '/') return;
    const text = anchor.text().replace(/\s+/g, ' ').trim().toLowerCase();
    const path = new URL(url).pathname.toLowerCase();

    let score = 0;
    if (text === 'blog') score = 4;
    else if (BLOG_WORDS.includes(text)) score = 3;
    else if (/^[a-z]*-?blog\/?$/.test(path.split('/').filter(Boolean).join('/'))) score = 2;
    if (score === 0) return;
    if (anchor.closest('header, nav').length > 0) score += 1;
    if (!best || score > best.score) best = { url, score };
  });
  return (best as { url: string } | null)?.url ?? null;
}

interface Candidate {
  url: string;
  depth: number;
  document?: SitemapDocument;
}

/**
 * Readable sitemaps among `urls` (same site only), with indexes expanded into their children
 * without fetching them yet. `firstOnly` stops at the first one that works: conventional
 * locations are guesses, and one answer is enough.
 */
async function collectCandidates(
  origin: string,
  urls: string[],
  fetcher: Fetcher,
  firstOnly = false,
): Promise<Map<string, Candidate>> {
  const candidates = new Map<string, Candidate>();
  for (const url of urls.slice(0, MAX_SITEMAP_FETCHES)) {
    const document = await tryReadSitemap(url, fetcher, SAMPLE_SIZE);
    if (!document) continue;
    addDocument(candidates, { url, depth: 0, document }, origin);
    if (firstOnly) break;
  }
  return candidates;
}

function addDocument(
  candidates: Map<string, Candidate>,
  candidate: Candidate,
  origin: string,
): void {
  const { document } = candidate;
  if (document?.kind === 'index') {
    if (candidate.depth >= MAX_INDEX_DEPTH) return;
    for (const child of document.urls) {
      if (isHttpUrl(child) && isSameSite(child, origin) && !candidates.has(child)) {
        candidates.set(child, { url: child, depth: candidate.depth + 1 });
      }
    }
    return;
  }
  candidates.set(candidate.url, candidate);
}

async function tryReadSitemap(
  url: string,
  fetcher: Fetcher,
  maxUrls: number,
): Promise<SitemapDocument | null> {
  try {
    const response = await fetcher.open(url, { accept: XML, maxBytes: SITEMAP_MAX_BYTES });
    if (response.status !== 200) {
      for await (const _chunk of response.chunks) break;
      return null;
    }
    const document = await readSitemap(response.chunks, maxUrls);
    return document.kind === 'unknown' ? null : document;
  } catch {
    return null;
  }
}

interface Family {
  /** post-sitemap.xml, post-sitemap2.xml, … in index order. */
  members: string[];
  sample: string[];
  score: number;
}

async function scoreFamilies(
  candidates: Map<string, Candidate>,
  hubUrl: string | null,
  origin: string,
  fetcher: Fetcher,
): Promise<Family[]> {
  const hubPath = hubUrl ? new URL(hubUrl).pathname.toLowerCase() : null;
  const byFamily = new Map<string, string[]>();
  for (const url of candidates.keys()) {
    const key = familyKey(url);
    byFamily.set(key, [...(byFamily.get(key) ?? []), url]);
  }

  // Judge the most promising families by name first, so a large index costs a few fetches.
  const ranked = [...byFamily.values()]
    .map((members) => ({ members, prior: nameScore(members[0] ?? '', hubPath) }))
    .sort((a, b) => b.prior - a.prior)
    .slice(0, CANDIDATES_TO_SAMPLE);

  const families: Family[] = [];
  let expanded = false;
  for (const { members, prior } of ranked) {
    const first = candidates.get(members[0] ?? '');
    if (!first) continue;
    first.document ??= (await tryReadSitemap(first.url, fetcher, SAMPLE_SIZE)) ?? undefined;
    if (!first.document) continue;
    if (first.document.kind === 'index') {
      // An index inside an index: its children replace it and the ranking runs again. Documents
      // already read stay on their candidates, so nothing is fetched twice.
      candidates.delete(first.url);
      addDocument(candidates, first, origin);
      expanded = true;
      continue;
    }
    const sample = first.document.urls;
    families.push({ members, sample, score: prior + contentScore(sample, hubUrl, hubPath) });
  }
  if (expanded) return scoreFamilies(candidates, hubUrl, origin, fetcher);
  return families.sort((a, b) => b.score - a.score);
}

/** "/blog/post/" is under "/blog" or "/blog/"; "/blogging-tools/" is not. */
function isUnder(path: string, hubPath: string): boolean {
  const base = hubPath.endsWith('/') ? hubPath : `${hubPath}/`;
  return path === hubPath || path.startsWith(base);
}

/** Sitemaps that differ only by a trailing number belong together (post-sitemap2.xml). */
function familyKey(url: string): string {
  return url.replace(/\d+(?=(\.xml)?(\.gz)?\/?$)/i, '');
}

function nameScore(url: string, hubPath: string | null): number {
  const path = new URL(url).pathname.toLowerCase();
  const tokens = path.split(/[^a-z0-9]+/).filter(Boolean);
  let score = 0;
  if (hubPath && hubPath !== '/' && isUnder(path, hubPath)) score += 40;
  if (tokens.some((token) => POSITIVE_TOKENS.has(token))) score += 15;
  if (tokens.some((token) => NEGATIVE_TOKENS.has(token))) score -= 30;
  return score;
}

function contentScore(sample: string[], hubUrl: string | null, hubPath: string | null): number {
  if (sample.length === 0) return -100;
  const paths = sample.map((url) => safePath(url));
  let score = 0;
  if (hubPath && hubPath !== '/') {
    const underHub = paths.filter((path) => isUnder(path, hubPath) && path !== hubPath).length;
    if (underHub / paths.length >= 0.5) score += 40;
    if (hubUrl && paths.includes(hubPath)) score += 40;
  }
  if (paths.filter(isArticleShaped).length / paths.length >= 0.6) score += 10;
  score += Math.min(10, Math.log2(sample.length + 1));
  return score;
}

/** One to three path segments ending in a hyphenated slug or a dated path. */
function isArticleShaped(path: string): boolean {
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0 || segments.length > 4) return false;
  const last = segments.at(-1) ?? '';
  return (last.match(/-/g) ?? []).length >= 2 || /\/\d{4}\/\d{2}\//.test(path);
}

/** URLs of the chosen family in order, reading more members only if the first is too short. */
async function familyUrls(family: Family, fetcher: Fetcher, limit: number): Promise<string[]> {
  const urls = [...family.sample];
  for (const member of family.members.slice(1)) {
    if (urls.length >= limit * 3) break;
    const document = await tryReadSitemap(member, fetcher, SAMPLE_SIZE);
    if (document) urls.push(...document.urls);
  }
  return urls;
}

/** Sitemap order, deduplicated; drops the hub, archives, pagination, files and other sites. */
export function selectPosts(
  urls: string[],
  origin: string,
  hubUrl: string | null,
  limit: number,
): string[] {
  const hubPath = hubUrl ? new URL(hubUrl).pathname.toLowerCase() : null;
  const normalized = urls
    .map((url) => normalizePageUrl(url))
    .filter((url): url is string => url !== null);
  const underHub = (url: string) =>
    hubPath !== null && hubPath !== '/' && isUnder(safePath(url), hubPath);
  // In a sitemap that mixes everything, the blog is what sits under the hub.
  const restrictToHub =
    normalized.filter((url) => underHub(url) && safePath(url) !== hubPath).length >= limit / 3;

  const seen = new Set<string>();
  const posts: string[] = [];
  for (const url of normalized) {
    if (posts.length >= limit) break;
    if (seen.has(url) || !isSameSite(url, origin)) continue;
    seen.add(url);
    const path = safePath(url);
    const segments = path.split('/').filter(Boolean);
    if (segments.length === 0 || path === hubPath) continue;
    if (restrictToHub && !underHub(url)) continue;
    if (segments.some((segment) => ARCHIVE_SEGMENTS.has(segment))) continue;
    if (/\/page\/\d+\/?$/.test(path) || NON_HTML.test(path)) continue;
    posts.push(url);
  }
  return posts;
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return '';
  }
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
