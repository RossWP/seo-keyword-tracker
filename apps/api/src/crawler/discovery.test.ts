import { afterEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureRoute } from '../test/fixture-server.js';
import { discoverBlog, findBlogHub } from './discovery.js';
import { CrawlError } from './errors.js';
import { createFetcher, type Fetcher } from './fetcher.js';

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

  it('finds the blog sitemap next to the hub when robots.txt and the root sitemap miss it (Ahrefs-like)', async () => {
    const server = await site((origin) => ({
      '/': html('<header><nav><a href="/blog/">Blog</a></nav></header>'),
      '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /search/\n' },
      '/sitemap.xml': index([`${origin}/seo/glossary/sitemap.xml`]),
      '/seo/glossary/sitemap.xml': urlset([
        `${origin}/seo/glossary`,
        ...Array.from({ length: 20 }, (_, i) => `${origin}/seo/glossary/term-${i}`),
      ]),
      '/blog/sitemap_index.xml': index([
        `${origin}/blog/post-sitemap.xml`,
        `${origin}/blog/post-sitemap2.xml`,
        `${origin}/blog/page-sitemap.xml`,
        `${origin}/blog/category-sitemap.xml`,
        `${origin}/blog/author-sitemap.xml`,
      ]),
      '/blog/post-sitemap.xml': urlset(posts(origin, '/blog/', 10)),
      '/blog/post-sitemap2.xml': urlset(posts(origin, '/blog/', 10, 10)),
      '/blog/page-sitemap.xml': urlset([`${origin}/blog/`, `${origin}/blog/about/`]),
      '/blog/category-sitemap.xml': urlset([`${origin}/blog/category/seo/`]),
      '/blog/author-sitemap.xml': urlset([`${origin}/blog/author/tim/`]),
    }));

    const result = await discoverBlog(server.origin, { fetcher, robotsAgent: 'TestBot' });

    expect(result.sitemapUrls).toEqual([
      `${server.origin}/blog/post-sitemap.xml`,
      `${server.origin}/blog/post-sitemap2.xml`,
    ]);
    expect(result.entries).toHaveLength(15);
    expect(result.entries.every((entry) => entry.url.startsWith(`${server.origin}/blog/`))).toBe(
      true,
    );
  });

  it('does not crawl a sitemap with no sign of a blog just because it is the only one', async () => {
    const server = await site((origin) => ({
      '/': html('<nav><a href="/blog/">Blog</a></nav>'),
      '/sitemap.xml': urlset([
        `${origin}/seo/glossary`,
        ...Array.from({ length: 20 }, (_, i) => `${origin}/seo/glossary/term${i}`),
      ]),
    }));

    await expect(
      discoverBlog(server.origin, { fetcher, robotsAgent: 'TestBot' }),
    ).rejects.toMatchObject({ code: 'no_blog_found' });
  });

  it('waits longer for a large, slowly generated sitemap than for a page', async () => {
    const server = await site((origin) => ({
      '/': html('<nav><a href="/blog/">Blog</a></nav>'),
      '/blog/sitemap_index.xml': (_request, response) => {
        // Slower than the fetcher's page timeout (2 s in these tests), well within the sitemap one.
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'text/xml' }).end(
            `<urlset>${posts(origin, '/blog/', 3)
              .map((url) => `<url><loc>${url}</loc></url>`)
              .join('')}</urlset>`,
          );
        }, 2_500);
      },
    }));

    const result = await discoverBlog(server.origin, { fetcher, robotsAgent: 'TestBot' });

    expect(result.sitemapUrls).toEqual([`${server.origin}/blog/sitemap_index.xml`]);
  }, 15_000);

  it('follows a blog on its own subdomain (blog.example.com)', async () => {
    const pages: Record<string, { type?: string; body: string }> = {
      'https://www.acme.example/': {
        body: '<header><nav><a href="https://blog.acme.example/">Blog</a></nav></header>',
      },
      'https://www.acme.example/sitemap.xml': {
        type: 'text/xml',
        body: '<urlset><url><loc>https://www.acme.example/pricing</loc></url></urlset>',
      },
      'https://blog.acme.example/robots.txt': {
        type: 'text/plain',
        body: 'Sitemap: https://blog.acme.example/sitemap-posts.xml\n',
      },
      'https://blog.acme.example/sitemap-posts.xml': {
        type: 'text/xml',
        body: `<urlset>${posts('https://blog.acme.example', '/', 4)
          .map((url) => `<url><loc>${url}</loc></url>`)
          .join('')}</urlset>`,
      },
    };

    const result = await discoverBlog('https://www.acme.example/', {
      fetcher: stubFetcher(pages),
      robotsAgent: 'TestBot',
    });

    expect(result.sitemapUrls).toEqual(['https://blog.acme.example/sitemap-posts.xml']);
    expect(result.entries.map((entry) => entry.url)).toEqual(
      posts('https://blog.acme.example', '/', 4),
    );
  });

  it('keeps only the posts section of a sitemap that mixes everything (Substack-like)', async () => {
    const server = await site((origin) => ({
      '/': html('<p>A newsletter</p>'),
      '/sitemap.xml': urlset([
        `${origin}/archive`,
        `${origin}/about`,
        `${origin}/podcast`,
        ...Array.from({ length: 10 }, (_, i) => `${origin}/p/post-number-${i}`),
      ]),
    }));

    const result = await discoverBlog(server.origin, { fetcher, robotsAgent: 'TestBot' });

    expect(result.entries).toHaveLength(10);
    expect(result.entries.every((entry) => new URL(entry.url).pathname.startsWith('/p/'))).toBe(
      true,
    );
  });

  it('prefers the default-language blog sitemap over a translated copy', async () => {
    const server = await site((origin) => ({
      '/': html('<p>No blog link</p>'),
      '/robots.txt': {
        type: 'text/plain',
        body: `Sitemap: ${origin}/fr/blog/sitemap.xml\nSitemap: ${origin}/blog/sitemap.xml\n`,
      },
      '/fr/blog/sitemap.xml': urlset(posts(origin, '/fr/blog/', 5)),
      '/blog/sitemap.xml': urlset(posts(origin, '/blog/', 5)),
    }));

    const result = await discoverBlog(server.origin, { fetcher, robotsAgent: 'TestBot' });

    expect(result.sitemapUrls).toEqual([`${server.origin}/blog/sitemap.xml`]);
  });

  it('reads sitemaps served from another host, such as a CDN (Webflow-like)', async () => {
    const server = await site((origin) => {
      const cdn = origin.replace('127.0.0.1', 'localhost');
      return {
        '/': html('<nav><a href="/blog">Blog</a></nav>'),
        '/robots.txt': { type: 'text/plain', body: `Sitemap: ${origin}/sitemap.xml\n` },
        '/sitemap.xml': { status: 302, headers: { location: `${cdn}/cdn/sitemap.xml` }, body: '' },
        '/cdn/sitemap.xml': index([`${cdn}/cdn/blog-posts.xml`, `${cdn}/cdn/other-site.xml`]),
        '/cdn/blog-posts.xml': urlset(posts(origin, '/blog/', 4)),
        '/cdn/other-site.xml': urlset(posts('https://elsewhere.example', '/blog/', 9)),
      };
    });

    const result = await discoverBlog(server.origin, { fetcher, robotsAgent: 'TestBot' });

    expect(result.entries.map((entry) => entry.url)).toEqual(posts(server.origin, '/blog/', 4));
  });

  it('picks the posts sitemap over other sitemaps in the same blog folder (Atlassian-like)', async () => {
    const server = await site((origin) => ({
      '/': html('<nav><a href="/blog">Blog</a></nav>'),
      '/robots.txt': { type: 'text/plain', body: `Sitemap: ${origin}/blog/sitemap_index.xml\n` },
      '/blog/sitemap_index.xml': index([
        `${origin}/blog/post-sitemap.xml`,
        `${origin}/blog/atl_links-sitemap.xml`,
        `${origin}/blog/atl_quiz-sitemap.xml`,
      ]),
      // Old posts with underscore slugs, as in a long-running blog.
      '/blog/post-sitemap.xml': urlset(
        Array.from({ length: 8 }, (_, i) => `${origin}/blog/archives/jira_news_item_${i}`),
      ),
      '/blog/atl_links-sitemap.xml': urlset(posts(origin, '/blog/links/', 8)),
      '/blog/atl_quiz-sitemap.xml': urlset(posts(origin, '/blog/quiz/', 8)),
    }));

    const result = await discoverBlog(server.origin, { fetcher, robotsAgent: 'TestBot' });

    expect(result.sitemapUrls).toEqual([`${server.origin}/blog/post-sitemap.xml`]);
  });

  it('takes the blog posts out of one big sitemap of everything (Vercel-like)', async () => {
    const server = await site((origin) => {
      const all: string[] = [];
      for (let i = 0; i < 300; i++) {
        all.push(`${origin}/docs/page-${i}`);
        if (i % 10 === 0) all.push(`${origin}/blog/how-to-topic-${i / 10}`);
      }
      return {
        '/': html('<nav><a href="/blog">Blog</a></nav>'),
        '/robots.txt': { type: 'text/plain', body: `Sitemap: ${origin}/crawled-sitemap.xml\n` },
        '/crawled-sitemap.xml': urlset(all),
      };
    });

    const result = await discoverBlog(server.origin, { fetcher, robotsAgent: 'TestBot' });

    expect(result.entries).toHaveLength(15);
    expect(result.entries.every((entry) => new URL(entry.url).pathname.startsWith('/blog/'))).toBe(
      true,
    );
  });

  it('looks through the parts of a split sitemap for the blog (Stripe-like)', async () => {
    const server = await site((origin) => ({
      '/': html('<nav><a href="/blog">Blog</a></nav>'),
      '/robots.txt': { type: 'text/plain', body: `Sitemap: ${origin}/sitemap/sitemap.xml\n` },
      '/sitemap/sitemap.xml': index(
        [0, 1, 2, 3].map((i) => `${origin}/sitemap/partition-${i}.xml`),
      ),
      '/sitemap/partition-0.xml': urlset(
        Array.from({ length: 20 }, (_, i) => `${origin}/pricing/page${i}`),
      ),
      '/sitemap/partition-1.xml': urlset(
        Array.from({ length: 20 }, (_, i) => `${origin}/payments/page${i}`),
      ),
      '/sitemap/partition-2.xml': urlset(posts(origin, '/blog/', 20)),
      '/sitemap/partition-3.xml': urlset(
        Array.from({ length: 20 }, (_, i) => `${origin}/docs/page${i}`),
      ),
    }));

    const result = await discoverBlog(server.origin, { fetcher, robotsAgent: 'TestBot' });

    expect(result.entries).toHaveLength(15);
    expect(result.entries.every((entry) => new URL(entry.url).pathname.startsWith('/blog/'))).toBe(
      true,
    );
  });

  it('does not take the pages of a whole site as its blog when nothing marks a blog', async () => {
    const server = await site((origin) => ({
      '/': html('<p>Головна</p>'),
      '/sitemap.xml': urlset(
        Array.from({ length: 30 }, (_, i) => `${origin}/ua/aktsiia-dlia-klientiv-${i}`),
      ),
    }));

    await expect(
      discoverBlog(server.origin, { fetcher, robotsAgent: 'TestBot' }),
    ).rejects.toMatchObject({ code: 'no_blog_found' });
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

describe('findBlogHub', () => {
  it('accepts a blog subdomain but not another site', () => {
    const html =
      '<nav><a href="https://other.example/blog/">Blog</a><a href="https://blog.acme.example/">Blog</a></nav>';
    expect(findBlogHub(html, 'https://www.acme.example/', 'https://www.acme.example/')).toBe(
      'https://blog.acme.example/',
    );
  });
});

/** In-memory fetcher for hosts the fixture server can't stand in for (subdomains). */
function stubFetcher(pages: Record<string, { type?: string; body: string }>): Fetcher {
  const respond = (url: string) => {
    const page = pages[url];
    const body = new TextEncoder().encode(page?.body ?? 'not found');
    return {
      url,
      status: page ? 200 : 404,
      headers: new Headers(),
      contentType: page?.type ?? 'text/html',
      body,
    };
  };
  return {
    fetch: async (url) => ({ ...respond(url), elapsedMs: 1 }),
    open: async (url) => {
      const { body, ...rest } = respond(url);
      return {
        ...rest,
        chunks: (async function* () {
          yield body;
        })(),
      };
    },
  };
}
