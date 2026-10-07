# Design notes

The README is the one-page summary; this file has the detail behind it.

## What's implemented

- **Seed:** 2 users with one client each, 15 posts per client crawled live. The demo data is
  87,600 snapshots for 240 page–keyword pairs. The seed fails if a demo client ends up with no
  keywords or if there are fewer than 50,000 snapshots.
- **Keywords:** up to 8 per page, each with where it was found (title, H1, slug, headings, body).
- **SEO issues:** 13 rules plus `http_error`, each an error or a warning: noindex, missing or
  duplicate title, title length, missing meta description, missing or multiple H1, missing or
  mismatched canonical, thin content, client-rendered page, images without alt, mixed content.
- **Auth:** session cookie (`httpOnly`, `SameSite=Lax`, 7-day sliding expiry); only a SHA-256 of
  the token is stored. Login is rate-limited per IP and email; state-changing requests have an
  Origin check. The browser cache is cleared whenever a different user signs in.
- **Pages list:** client filter, search by URL or keyword (trigram indexes), pagination, latest
  position, issue count. Filters live in the URL, so refresh, links and Back work.
- **Page detail:** keywords, issues, and position history as a chart or a table, over a picked
  range (presets 7/30/90/365 days, default 90, at most 730).
- **Add client:** invalid URLs and private hosts are rejected; the same site twice for one user
  is a 409 (`www.`, scheme and trailing slash don't count as differences; a unique index enforces
  it). `202` and a background crawl whose progress shows on the Clients page. A site without a
  sitemap or a blog ends as `failed` with a readable reason and a Retry button.

## How the blog sitemap is found

1. **Blog hub.** Fetch the homepage (following redirects) and find a "Blog"-like link, preferring
   one in the header or nav. A path in the entered URL (`example.com/blog/`) is used as the hub.
2. **Candidates.** Same-site `Sitemap:` lines from robots.txt. If none of them leads to blog
   posts, the usual paths are tried: `/sitemap.xml`, `/sitemap_index.xml`, `/sitemap-index.xml`,
   `/wp-sitemap.xml`, `/sitemap/`, `/blog/sitemap.xml`. Indexes are expanded up to 3 levels deep.
3. **Families.** Sitemaps that differ only by a trailing number belong together
   (`post-sitemap.xml`, `post-sitemap2.xml`).
4. **Score.** Under the hub path +40; `post`/`blog`/`article` in the name +15; `product`, `tag`,
   `author`, `docs` and similar −30. From a sample of up to 500 URLs: mostly under the hub +40,
   lists the hub +40, mostly article-shaped (multi-word slugs, `/yyyy/mm/`) +10.
5. **Posts.** The first 15 URLs of the best family in sitemap order, skipping the hub, archives
   (`/category/`, `/tag/`, `/page/2`), files and other hosts.

## Crawling: what can go wrong

| Situation                              | Handling                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| robots.txt disallows a URL             | Listed as `skipped_robots`, never fetched.                                                      |
| Crawl-delay in robots.txt              | Honoured, capped at 5 s (Semrush asks for 20 s, i.e. 5 minutes per crawl).                      |
| 429, 5xx or a timeout                  | Retried with backoff, honouring `Retry-After` up to 30 s.                                       |
| 403/429 or a bot challenge             | Page marked `blocked`; after 3 in a row the crawl stops as `partial` with `blocked_by_site`.    |
| One page fails                         | Saved with an `http_error` issue; on a recrawl its keywords and history are kept.               |
| Huge, gzip-bombed or looping responses | 5 MB page / 50 MB sitemap cap after decompression, 5 redirects, clear error codes.              |
| Private or internal address            | Rejected on input and on every DNS lookup and redirect hop.                                     |
| The API stops or crashes mid-crawl     | State lives on the client row. A heartbeat every 30 s; crawls silent for 2 minutes are resumed. |
| Graceful shutdown                      | Handed back to `pending` after the current page; one stopped mid-discovery resumes once stale.  |
| Two crawls at once                     | An atomic claim (`UPDATE … WHERE status = 'pending'`) lets only one runner take a crawl.        |

## Decisions in more detail

- **Job state on `clients`, queue in-process.** No broker, safe restarts. Cost: one instance.
- **Keyword scoring.** Location weights (title 3, H1 3, slug 2.5, structured data 2, headings 1.5,
  meta 1.5, intro 1.2) plus log body frequency, ×1.3 for 2–3 words, × site IDF, minimum score 2,
  overlapping phrases deduplicated. Phrases can't start or end with a stopword or number; brand
  words come from the title suffix most pages share.
- **Generated ranks.** mulberry32 seeded with FNV-1a of page and keyword; mean-reverting walk,
  shared "update" days (~2%), ~5% of days outside the top 100 (`null`). Days of history =
  max(365, ⌈50,000 / pairs⌉). Inserted with `unnest()` in batches of 10,000.
- **Time zones.** A local range `[from, to]` becomes `[from 00:00, to+1 00:00)` in the user's zone,
  converted by Postgres, so DST days (23 or 25 hours) are right and the index stays usable.
- **Query performance.** The latest position is a lateral join on
  `(page_keyword_id, captured_at DESC NULLS LAST)`; a mismatched `ORDER BY` first made Postgres
  sort the whole history (18 ms → 5 ms per list page once fixed, measured with `EXPLAIN ANALYZE`).
- **Zod on every boundary.** Request, response, raw SQL rows and API answers in the web app. One
  error shape: `{ error: { code, message, details } }`.

## Assumptions

- The user's time zone is a per-user setting, defaulting to `America/Toronto`.
- `null` means "not in the top 100" and is a gap in the chart; no history yet is shown as such.
- "First 15 posts" means the first 15 in sitemap order, not the newest.
- A subdomain is a different site; `www.` is not.

## Testing

- **API:** against a real Postgres `<db>_test` database, recreated on each run. Auth, isolation
  with two users, validation and the contract of every route, time zones and DST, discovery and
  crawl against a local fixture server (Semrush-like, Yoast-like, WordPress, nested and broken
  sitemaps, blocking), SSRF, fetcher, keyword and issue rules, rank generator, restart and
  shutdown behaviour.
- **Web:** Testing Library with a fake API: login and protected routes, switching users, URL
  filters and pagination, add-client errors, the chart, refresh after a crawl.
- **Manual:** live discovery and seed on both sites, the UI at desktop and phone width.
