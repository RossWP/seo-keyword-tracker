import { afterEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureRoute } from '../test/fixture-server.js';
import { discoverBlog } from './discovery.js';
import { CrawlError } from './errors.js';
import { createFetcher } from './fetcher.js';

const fetcher = createFetcher({
  userAgent: 'test-bot',
  timeoutMs: 2_000,
  attempts: 1,
  allowPrivateNetworks: true,
});
const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** Starts a fake site; routes get the server origin so they can link to themselves. */
async function site(build: (origin: string) => Record<string, FixtureRoute>) {
  const routes: Record<string, FixtureRoute> = {};
  const server = await startFixtureServer(routes);
  Object.assign(routes, build(server.origin));
  servers.push(server);
  return server;
}

const xml = (body: string): FixtureRoute => ({ type: 'text/xml; charset=utf-8', body });
const urlset = (urls: string[]) =>
  xml(
    `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">${urls
      .map(
        (url) =>
          `<url><loc>${url}</loc><image:image><image:loc>${url}cover.png</image:loc></image:image></url>`,
      )
      .join('')}</urlset>`,
  );
const index = (urls: string[]) =>
  xml(
    `<sitemapindex>${urls.map((url) => `<sitemap><loc>${url}</loc></sitemap>`).join('')}</sitemapindex>`,
  );
const html = (body: string): FixtureRoute => ({
  body: `<!doctype html><html><body>${body}</body></html>`,
});
const posts = (origin: string, prefix: string, count: number, from = 0) =>
  Array.from({ length: count }, (_, i) => `${origin}${prefix}how-to-topic-${i + from}/`);

describe('discoverBlog', () => {
  it('finds a blog sitemap without .xml among section sitemaps (Semrush-like)', async () => {
    const server = await site((origin) => ({
      '/': html(
        '<header><nav><a href="/features/">Features</a><a href="/blog/">Blog</a></nav></header>' +
          '<footer><a href="/blog/">Semrush Blog</a><a href="/kb/">Knowledge base</a></footer>',
      ),
      '/robots.txt': {
        type: 'text/plain',
        body: `User-agent: *\nDisallow: /blog/search/\nCrawl-delay: 20\nSitemap: ${origin}/sitemap.xml\nSitemap: https://de.example.org/blog/sitemap/\n`,
      },
      '/sitemap.xml': index([
        `${origin}/website-pages-sitemap/`,
        `${origin}/news/sitemap/`,
        `${origin}/kb/sitemap/`,
        `${origin}/blog/sitemap/`,
        `${origin}/pricing/sitemap.xml`,
      ]),
      '/website-pages-sitemap/': urlset([
        `${origin}/`,
        `${origin}/features/`,
        `${origin}/pricing/`,
      ]),
      '/news/sitemap/': urlset(posts(origin, '/news/', 8)),
      '/kb/sitemap/': urlset(posts(origin, '/kb/', 40)),
      '/blog/sitemap/': urlset(posts(origin, '/blog/', 30)),
      '/pricing/sitemap.xml': urlset([`${origin}/pricing/`]),
    }));

    const result = await discoverBlog(server.origin, { fetcher, robotsAgent: 'TestBot' });

    expect(result.hubUrl).toBe(`${server.origin}/blog/`);
    expect(result.sitemapUrls).toEqual([`${server.origin}/blog/sitemap/`]);
    expect(result.entries.map((entry) => entry.url)).toEqual(posts(server.origin, '/blog/', 15));
    expect(result.crawlDelaySeconds).toBe(20);
  });

  it('picks the main post sitemaps over a smaller blog-named one and skips the hub (Yoast-like)', async () => {
    const server = await site((origin) => ({
      '/': html(
        '<nav><a href="/seo-blog/">Blog</a><a href="/developer-blog/">Developer blog Built by engineers</a></nav>',
      ),
      '/robots.txt': {
        type: 'text/plain',
        body: `User-agent: *\nDisallow: /wp-json/\nSitemap: ${origin}/sitemap_index.xml\n`,
      },
      '/sitemap_index.xml': index([
        `${origin}/post-sitemap.xml`,
        `${origin}/post-sitemap2.xml`,
        `${origin}/page-sitemap.xml`,
        `${origin}/product-sitemap.xml`,
        `${origin}/yoast_developer_blog-sitemap.xml`,
      ]),
      '/post-sitemap.xml': urlset([`${origin}/seo-blog/`, ...posts(origin, '/', 10)]),
      '/post-sitemap2.xml': urlset(posts(origin, '/', 10, 10)),
      '/page-sitemap.xml': urlset([`${origin}/about-us/`, `${origin}/contact/`]),
      '/product-sitemap.xml': urlset([`${origin}/wordpress/plugins/seo/`]),
      '/yoast_developer_blog-sitemap.xml': urlset(posts(origin, '/developer-blog/', 5)),
    }));

    const result = await discoverBlog(server.origin, { fetcher, robotsAgent: 'TestBot' });

    expect(result.hubUrl).toBe(`${server.origin}/seo-blog/`);
    expect(result.sitemapUrls).toEqual([
      `${server.origin}/post-sitemap.xml`,
      `${server.origin}/post-sitemap2.xml`,
    ]);
    const urls = result.entries.map((entry) => entry.url);
    expect(urls).toHaveLength(15);
    expect(urls[0]).toBe(`${server.origin}/how-to-topic-0/`);
    expect(urls.at(-1)).toBe(`${server.origin}/how-to-topic-14/`);
    expect(urls).not.toContain(`${server.origin}/seo-blog/`);
  });

  it('falls back to conventional locations when robots.txt has no sitemap (WordPress core)', async () => {
    const server = await site((origin) => ({
      '/': html('<p>No blog link here</p>'),
      '/wp-sitemap.xml': index([
        `${origin}/wp-sitemap-posts-page-1.xml`,
        `${origin}/wp-sitemap-posts-post-1.xml`,
        `${origin}/wp-sitemap-taxonomies-category-1.xml`,
        `${origin}/wp-sitemap-users-1.xml`,
      ]),
      '/wp-sitemap-posts-page-1.xml': urlset([`${origin}/about/`, `${origin}/contact/`]),
      '/wp-sitemap-posts-post-1.xml': urlset(posts(origin, '/2026/05/', 4)),
      '/wp-sitemap-taxonomies-category-1.xml': urlset([`${origin}/category/news/`]),
      '/wp-sitemap-users-1.xml': urlset([`${origin}/author/admin/`]),
    }));

    const result = await discoverBlog(server.origin, { fetcher, robotsAgent: 'TestBot' });

    expect(result.sitemapUrls).toEqual([`${server.origin}/wp-sitemap-posts-post-1.xml`]);
    expect(result.entries).toHaveLength(4);
  });

  it('follows nested sitemap indexes', async () => {
    const server = await site((origin) => ({
      '/': html('<nav><a href="/blog/">Blog</a></nav>'),
      '/robots.txt': { type: 'text/plain', body: `Sitemap: ${origin}/sitemap.xml\n` },
      '/sitemap.xml': index([`${origin}/sitemaps/content.xml`, `${origin}/sitemaps/pages.xml`]),
      '/sitemaps/content.xml': index([`${origin}/sitemaps/blog-posts.xml`]),
      '/sitemaps/pages.xml': urlset([`${origin}/about/`, `${origin}/pricing/`]),
      '/sitemaps/blog-posts.xml': urlset(posts(origin, '/blog/', 5)),
    }));

    const result = await discoverBlog(server.origin, { fetcher, robotsAgent: 'TestBot' });

    expect(result.sitemapUrls).toEqual([`${server.origin}/sitemaps/blog-posts.xml`]);
    expect(result.entries).toHaveLength(5);
  });

  it('tries conventional locations when the sitemaps in robots.txt are broken', async () => {
    const server = await site((origin) => ({
      '/': html('<nav><a href="/blog/">Blog</a></nav>'),
      '/robots.txt': { type: 'text/plain', body: `Sitemap: ${origin}/old-sitemap.xml\n` },
      '/sitemap.xml': urlset(posts(origin, '/blog/', 3)),
    }));

    const result = await discoverBlog(server.origin, { fetcher, robotsAgent: 'TestBot' });

    expect(result.sitemapUrls).toEqual([`${server.origin}/sitemap.xml`]);
    expect(result.entries).toHaveLength(3);
  });

  it('falls back to conventional locations when the robots.txt index only lists dead sitemaps', async () => {
    const server = await site((origin) => ({
      '/': html('<nav><a href="/blog/">Blog</a></nav>'),
      '/robots.txt': { type: 'text/plain', body: `Sitemap: ${origin}/sitemaps/index.xml\n` },
      '/sitemaps/index.xml': index([
        `${origin}/sitemaps/gone-1.xml`,
        `${origin}/sitemaps/gone-2.xml`,
      ]),
      '/sitemap_index.xml': urlset(posts(origin, '/blog/', 4)),
    }));

    const result = await discoverBlog(server.origin, { fetcher, robotsAgent: 'TestBot' });

    expect(result.sitemapUrls).toEqual([`${server.origin}/sitemap_index.xml`]);
    expect(result.entries).toHaveLength(4);
  });

  it('does not treat /blogging-tools/ as part of a /blog hub', async () => {
    const server = await site((origin) => ({
      '/': html('<nav><a href="/blog">Blog</a></nav>'),
      '/sitemap.xml': urlset([
        ...posts(origin, '/blogging-tools/', 6),
        ...posts(origin, '/blog/', 6),
      ]),
    }));

    const result = await discoverBlog(server.origin, { fetcher, robotsAgent: 'TestBot' });

    expect(result.entries.map((entry) => new URL(entry.url).pathname)).toEqual(
      posts('', '/blog/', 6),
    );
  });

  it('keeps only blog URLs from a flat sitemap and flags robots-disallowed posts', async () => {
    const server = await site((origin) => ({
      '/': html('<header><a href="/blog/">Blog</a></header>'),
      '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /blog/private-' },
      '/sitemap.xml': urlset([
        `${origin}/`,
        `${origin}/about/`,
        `${origin}/blog/`,
        `${origin}/blog/private-launch-notes/`,
        ...posts(origin, '/blog/', 5),
        `${origin}/blog/page/2/`,
        `${origin}/blog/category/news/`,
        `${origin}/blog/how-to-topic-0/?utm_source=x#top`,
        `https://elsewhere.example.com/blog/a-b-c/`,
        `${origin}/pricing/`,
      ]),
    }));

    const result = await discoverBlog(server.origin, { fetcher, robotsAgent: 'TestBot' });

    expect(result.entries).toEqual([
      { url: `${server.origin}/blog/private-launch-notes/`, allowedByRobots: false },
      ...posts(server.origin, '/blog/', 5).map((url) => ({ url, allowedByRobots: true })),
    ]);
  });

  it('uses a path in the entered URL as the blog hub', async () => {
    const server = await site((origin) => ({
      '/journal/': html('<p>Journal</p>'),
      '/sitemap.xml': urlset([
        `${origin}/shop/`,
        ...posts(origin, '/journal/', 6),
        `${origin}/about/`,
      ]),
    }));

    const result = await discoverBlog(`${server.origin}/journal/`, {
      fetcher,
      robotsAgent: 'TestBot',
    });
    expect(result.hubUrl).toBe(`${server.origin}/journal/`);
    expect(result.entries).toHaveLength(6);
  });

  it('reports a site without any sitemap', async () => {
    const server = await site(() => ({ '/': html('<p>hello</p>') }));
    await expect(
      discoverBlog(server.origin, { fetcher, robotsAgent: 'TestBot' }),
    ).rejects.toMatchObject({
      code: 'no_sitemap',
    });
  });

  it('reports a site that refuses the crawler', async () => {
    const server = await site(() => ({ '/': { status: 403, body: 'Forbidden' } }));
    const error: unknown = await discoverBlog(server.origin, {
      fetcher,
      robotsAgent: 'TestBot',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CrawlError);
    expect(error).toMatchObject({ code: 'blocked_by_site' });
  });
});
