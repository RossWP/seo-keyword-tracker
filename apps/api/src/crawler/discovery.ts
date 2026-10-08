import * as cheerio from 'cheerio';
import { isSameSite, normalizePageUrl, siteKeyOf } from '../lib/url.js';
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
/** Big blog sitemaps are often generated on request and arrive slowly (Ahrefs: 2.6 MB in ~26 s). */
const SITEMAP_TIMEOUT_MS = 60_000;
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
const GENERIC_NAME_WORDS = new Set([
  'sitemap',
  'sitemaps',
  'index',
  'xml',
  'gz',
  'partition',
  'part',
]);
/** Hub URLs that prove a sitemap carries the blog, even among everything else. */
const MIN_HUB_URLS = 5;
/** Parts of a split sitemap read while looking for the blog. */
const MAX_PARTS_TO_SCAN = 10;
/** "fr", "de-de", "pt-br", "zh-hans": a language or region segment in a path. */
const LOCALE_SEGMENT = /^[a-z]{2}(-[a-z]{2,4})?$/;
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
  const hubUrl = findBlogHub(homepage.html, homepage.url, siteUrl);
  // A blog on its own subdomain has its own robots.txt and sitemaps: discovery continues there.
  const origin = new URL(hubUrl && !isSameSite(hubUrl, homepage.url) ? hubUrl : homepage.url)
    .origin;

  const robotsUrl = `${origin}/robots.txt`;
  const robots = parseRobots(robotsUrl, await fetchRobots(robotsUrl, fetcher));
  const crawlDelay = robots.getCrawlDelay(robotsAgent) ?? robots.getCrawlDelay('*') ?? null;

  // First round: robots.txt entries plus the sitemap next to the blog hub, judged together.
  // Blogs often run their own CMS with their own sitemap (/blog/sitemap_index.xml) that the
  // site's robots.txt or root sitemap never mentions. If that round finds no blog posts
  // (nothing listed, broken, or an index whose children are dead), the root locations get
  // their turn.
  const robotsSitemaps = robots
    .getSitemaps()
    .filter((url) => isHttpUrl(url) && isSameSite(url, origin));
  const rounds = [
    [{ urls: robotsSitemaps }, { urls: hubSitemapUrls(hubUrl, origin), firstOnly: true }],
    [{ urls: CONVENTIONAL_SITEMAPS.map((path) => origin + path), firstOnly: true }],
  ];
  let foundSitemap = false;
  let found: { family: Family; posts: string[] } | null = null;
  for (const round of rounds) {
    const candidates = new Map<string, Candidate>();
    for (const { urls, firstOnly } of round) {
      for (const [url, candidate] of await collectCandidates(urls, fetcher, firstOnly)) {
        if (!candidates.has(url)) candidates.set(url, candidate);
      }
    }
    if (candidates.size === 0) continue;
    foundSitemap = true;
    const [best] = await scoreFamilies(candidates, hubUrl, origin, fetcher);
    const posts = best
      ? selectPosts(await familyUrls(best, origin, hubUrl, fetcher, limit), origin, hubUrl, limit, {
          postsOnly: hasPostsName(best.members[0] ?? ''),
        })
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

/** blog.example.com is a subdomain of example.com (and of www.example.com); example.org is not. */
function isSubdomainOf(hostname: string, siteHostname: string): boolean {
  const host = hostname.toLowerCase();
  const site = siteKeyOf(siteHostname);
  return host !== site && host !== `www.${site}` && host.endsWith(`.${site}`);
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
    if (!url) return;
    const { hostname, pathname } = new URL(url);
    // A blog often lives on its own subdomain (blog.example.com); any other host is not ours.
    const onSubdomain = isSubdomainOf(hostname, new URL(pageUrl).hostname);
    if (!onSubdomain && (!isSameSite(url, pageUrl) || pathname === '/')) return;
    const text = anchor.text().replace(/\s+/g, ' ').trim().toLowerCase();
    const path = pathname.toLowerCase();
    const firstLabel = hostname.split('.')[0] ?? '';

    let score = 0;
    if (text === 'blog') score = 4;
    else if (BLOG_WORDS.includes(text)) score = 3;
    else if (/^[a-z]*-?blog\/?$/.test(path.split('/').filter(Boolean).join('/'))) score = 2;
    else if (onSubdomain && BLOG_WORDS.includes(firstLabel)) score = 2;
    if (score === 0) return;
    if (anchor.closest('header, nav').length > 0) score += 1;
    if (!best || score > best.score) best = { url, score };
  });
  return (best as { url: string } | null)?.url ?? null;
}

/** The usual sitemap file names inside the blog hub's own path, e.g. /blog/sitemap_index.xml. */
function hubSitemapUrls(hubUrl: string | null, origin: string): string[] {
  if (!hubUrl || !isSameSite(hubUrl, origin)) return [];
  const hubPath = new URL(hubUrl).pathname.replace(/\/?$/, '/');
  if (hubPath === '/') return [];
  return CONVENTIONAL_SITEMAPS.filter((path) => !path.startsWith('/blog/')).map(
    (path) => `${origin}${hubPath}${path.slice(1)}`,
  );
}

interface Candidate {
  url: string;
  depth: number;
  document?: SitemapDocument;
}

/**
 * Readable sitemaps among `urls`, with indexes expanded into their children without fetching
 * them yet. `firstOnly` stops at the first one that works: conventional
 * locations are guesses, and one answer is enough.
 */
async function collectCandidates(
  urls: string[],
  fetcher: Fetcher,
  firstOnly = false,
): Promise<Map<string, Candidate>> {
  const candidates = new Map<string, Candidate>();
  for (const url of urls.slice(0, MAX_SITEMAP_FETCHES)) {
    const document = await tryReadSitemap(url, fetcher, SAMPLE_SIZE);
    if (!document) continue;
    addDocument(candidates, { url, depth: 0, document });
    if (firstOnly) break;
  }
  return candidates;
}

function addDocument(candidates: Map<string, Candidate>, candidate: Candidate): void {
  const { document } = candidate;
  if (document?.kind === 'index') {
    if (candidate.depth >= MAX_INDEX_DEPTH) return;
    // Children may sit on a CDN (Webflow serves its sitemaps from CloudFront); the posts they
    // list must still belong to the site, which the sample check below makes sure of.
    for (const child of document.urls) {
      if (isHttpUrl(child) && !candidates.has(child)) {
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
    const response = await fetcher.open(url, {
      accept: XML,
      maxBytes: SITEMAP_MAX_BYTES,
      timeoutMs: SITEMAP_TIMEOUT_MS,
    });
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
  /** Same-site URLs read so far, from the first `membersRead` members. */
  sample: string[];
  membersRead: number;
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
      addDocument(candidates, first);
      expanded = true;
      continue;
    }
    const sample = first.document.urls.filter((url) => isSameSite(url, origin));
    let membersRead = 1;
    // A sitemap split into partitions (Stripe: partition-0…8) may hold the blog in a later part:
    // keep reading parts while the hub is known but none of its URLs has shown up yet.
    if (hubPath && hubPath !== '/' && !nameTokens(first.url).some((t) => NEGATIVE_TOKENS.has(t))) {
      while (
        countUnder(sample, hubPath) < MIN_HUB_URLS &&
        membersRead < Math.min(members.length, MAX_PARTS_TO_SCAN)
      ) {
        const next = await tryReadSitemap(members[membersRead] ?? '', fetcher, SAMPLE_SIZE);
        membersRead++;
        if (next?.kind === 'urlset')
          sample.push(...next.urls.filter((url) => isSameSite(url, origin)));
      }
    }
    if (!hasBlogEvidence(first.url, sample, hubPath)) continue;
    families.push({
      members,
      sample,
      membersRead,
      score: prior + contentScore(sample, hubUrl, hubPath),
    });
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

/**
 * A family only counts as the blog with at least one positive sign: a blog-like name, most URLs
 * under the hub, or article-shaped URLs. Otherwise the only sitemap left (a glossary, a product
 * catalogue) would be crawled as the blog just because nothing better was readable.
 */
function hasBlogEvidence(sitemapUrl: string, sample: string[], hubPath: string | null): boolean {
  if (sample.length === 0) return false;
  const name = new URL(sitemapUrl).pathname.toLowerCase();
  if (nameTokens(sitemapUrl).some((token) => POSITIVE_TOKENS.has(token))) return true;
  const paths = sample.map((url) => safePath(url));
  if (hubPath && hubPath !== '/') {
    if (isUnder(name, hubPath)) return true;
    // Enough hub URLs count even in a sitemap of everything (Vercel lists docs, KB and blog).
    const underHub = countUnder(sample, hubPath);
    if (underHub >= MIN_HUB_URLS || underHub / paths.length >= 0.5) return true;
  }
  return paths.filter(isArticleShaped).length / paths.length >= 0.6;
}

/**
 * Words in a sitemap's file name ("post-sitemap.xml" → post). When the name says nothing
 * ("sitemap.xml", "partition-3.xml"), the folder speaks for it ("/blog/sitemap/" → blog).
 * Without this, every sitemap inside /blog/ (links, quizzes, tags) would look like the posts.
 */
function nameTokens(sitemapUrl: string): string[] {
  const segments = new URL(sitemapUrl).pathname.toLowerCase().split('/').filter(Boolean);
  const words = (text: string) =>
    text
      .split(/[^a-z0-9]+/)
      .filter((word) => word && !GENERIC_NAME_WORDS.has(word) && !/^\d+$/.test(word));
  const own = words(segments.at(-1) ?? '');
  return own.length > 0 ? own : words(segments.join('/'));
}

/** Hub URLs among `urls`, not counting the hub page itself. */
function countUnder(urls: string[], hubPath: string): number {
  return urls.filter((url) => {
    const path = safePath(url);
    return path !== hubPath && isUnder(path, hubPath);
  }).length;
}

function nameScore(url: string, hubPath: string | null): number {
  const path = new URL(url).pathname.toLowerCase();
  const tokens = nameTokens(url);
  let score = 0;
  if (hubPath && hubPath !== '/' && isUnder(path, hubPath)) score += 40;
  if (tokens.some((token) => POSITIVE_TOKENS.has(token))) score += 15;
  if (tokens.some((token) => NEGATIVE_TOKENS.has(token))) score -= 30;
  // A translated copy (/fr/blog/sitemap.xml) loses to the default language when both exist.
  if (path.split('/').some((segment) => LOCALE_SEGMENT.test(segment))) score -= 10;
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
  return (last.match(/[-_]/g) ?? []).length >= 2 || /\/\d{4}\/\d{2}\//.test(path);
}

/** URLs of the chosen family in order, reading more members only if the first is too short. */
async function familyUrls(
  family: Family,
  origin: string,
  hubUrl: string | null,
  fetcher: Fetcher,
  limit: number,
): Promise<string[]> {
  const hubPath = hubUrl ? new URL(hubUrl).pathname.toLowerCase() : null;
  const enough = (urls: string[]) =>
    hubPath && hubPath !== '/' && countUnder(urls, hubPath) > 0
      ? countUnder(urls, hubPath) >= limit
      : urls.length >= limit * 3;
  const urls = [...family.sample];
  for (const member of family.members.slice(family.membersRead, MAX_PARTS_TO_SCAN)) {
    if (enough(urls)) break;
    const document = await tryReadSitemap(member, fetcher, SAMPLE_SIZE);
    if (document) urls.push(...document.urls.filter((url) => isSameSite(url, origin)));
  }
  return urls;
}

/** Sitemap order, deduplicated; drops the hub, archives, pagination, files and other sites. */
export function selectPosts(
  urls: string[],
  origin: string,
  hubUrl: string | null,
  limit: number,
  { postsOnly = false }: { postsOnly?: boolean } = {},
): string[] {
  const hubPath = hubUrl ? new URL(hubUrl).pathname.toLowerCase() : null;
  const normalized = urls
    .map((url) => normalizePageUrl(url))
    .filter((url): url is string => url !== null);
  const sectionPath =
    hubPath !== null && hubPath !== '/'
      ? hubPath
      : postsOnly
        ? null
        : inferSection(normalized, origin, limit);
  // A generic sitemap of a whole site, with no hub and no posts section in it, is not a blog:
  // taking its first 15 URLs would crawl promo and service pages.
  if (hubPath === null && !postsOnly && sectionPath === null) return [];
  const underHub = (url: string) => sectionPath !== null && isUnder(safePath(url), sectionPath);
  // In a sitemap that mixes everything, the blog is what sits under the hub.
  const restrictToHub =
    normalized.filter((url) => underHub(url) && safePath(url) !== sectionPath).length >= limit / 3;

  const seen = new Set<string>();
  const posts: string[] = [];
  for (const url of normalized) {
    if (posts.length >= limit) break;
    if (seen.has(url) || !isSameSite(url, origin)) continue;
    seen.add(url);
    const path = safePath(url);
    const segments = path.split('/').filter(Boolean);
    if (segments.length === 0 || path === hubPath || path === sectionPath) continue;
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

/** post-sitemap.xml, sitemap-posts.xml, sitemap_articles_1.xml: a sitemap of posts only. */
function hasPostsName(sitemapUrl: string): boolean {
  return nameTokens(sitemapUrl).some((token) => POSITIVE_TOKENS.has(token));
}

/**
 * Without a hub, a sitemap that mixes everything (about pages, the archive, posts) still shows
 * where posts live: a blog-word section (/blog/, /news/) with enough URLs, or a first path
 * segment most URLs share (/p/ on Substack). Null when nothing stands out.
 */
function inferSection(urls: string[], origin: string, limit: number): string | null {
  const counts = new Map<string, number>();
  let total = 0;
  for (const url of urls) {
    if (!isSameSite(url, origin)) continue;
    const segments = safePath(url).split('/').filter(Boolean);
    if (segments.length < 2) continue;
    total++;
    const first = segments[0] ?? '';
    counts.set(first, (counts.get(first) ?? 0) + 1);
  }
  // A language folder (/ua/, /en-us/) is the whole site in one language, not a section.
  const ranked = [...counts.entries()]
    .filter(([segment]) => !LOCALE_SEGMENT.test(segment))
    .sort((a, b) => b[1] - a[1]);
  const blogSection = ranked.find(
    ([segment, count]) => BLOG_WORDS.includes(segment) && count >= limit / 3,
  );
  if (blogSection) return `/${blogSection[0]}/`;
  const [top] = ranked;
  if (!top || /^\d+$/.test(top[0])) return null; // /2024/05/… is a date, not a section
  return top[1] >= limit / 3 && top[1] / Math.max(total, 1) >= 0.5 ? `/${top[0]}/` : null;
}
