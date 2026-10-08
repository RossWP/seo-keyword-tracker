# Design notes

The README is the one-page summary; this file has the detail behind it.

## Project structure

```text
compose.yaml, Dockerfile     Postgres, API and web (nginx) containers; `pnpm start` runs them
apps/api/
  migrations/                SQL migrations (pg_trgm, schema), applied on API start and by the seed
  src/server.ts              process entry: migrations, crawl runner, resume on boot, graceful stop
  src/app.ts                 Fastify app: helmet, cookies, rate limit, routes under /api
  src/db/schema.ts           tables, constraints and indexes (Drizzle)
  src/lib/                   error envelope, URL normalisation, passwords, LIKE escaping
  src/modules/auth/          session cookie, Origin check, login / logout / me
  src/modules/clients/       list, add (202 + background crawl), detail, recrawl
  src/modules/pages/         list with search and pagination, detail, rank history (raw SQL)
  src/crawler/discovery.ts   blog sitemap discovery (see below)
  src/crawler/fetcher.ts     HTTP: SSRF guard on every hop, retries, timeouts, size caps
  src/crawler/crawl-job.ts   one client's crawl end to end; crawl-runner.ts queues them
  src/crawler/analyze/       page facts, keyword scoring, SEO issue rules
  src/seed/                  demo users and clients, deterministic rank history
  src/test/                  test database, app context, factories, fixture HTTP server
apps/web/src/
  api/client.ts              fetch wrapper: error envelope → ApiError, Zod-checked responses
  app/                       routes, layout, not-found page
  features/auth/             login, protected routes, session handling
  features/pages/            pages list, page detail, rank chart, time-zone dates
  features/clients/          clients list with crawl progress, add-client form
```

## API

All routes except `/health` and `POST /api/auth/login` need the session cookie; without it they
answer 401. Every error has one shape: `{ "error": { "code", "message", "details"? } }`.
Validation errors list the bad fields in `details.issues[].path` (for example `body.websiteUrl`).
State-changing requests from another origin get 403 `forbidden_origin`.

| Method and path                 | Success                                              | Errors                                                   |
| ------------------------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| `GET /health`                   | 200 `{ status, database: "up" }`                     | 503 when the database is down                            |
| `POST /api/auth/login`          | 200 `{ user }` and the `sid` cookie                  | 400, 401 `invalid_credentials`, 429 `rate_limited`       |
| `POST /api/auth/logout`         | 204                                                  | —                                                        |
| `GET /api/auth/me`              | 200 `{ user: { id, email, timezone } }`              | 401                                                      |
| `GET /api/clients`              | 200 `{ items }` with crawl status and progress       | 401                                                      |
| `POST /api/clients`             | 202 and `Location`; the crawl runs in the background | 400 `invalid_url` / `blocked_host`, 409 `duplicate_site` |
| `GET /api/clients/:id`          | 200                                                  | 404                                                      |
| `POST /api/clients/:id/recrawl` | 202                                                  | 404, 409 `crawl_in_progress`                             |
| `GET /api/pages`                | 200 `{ items, page, pageSize, total }`               | 400, 404 for a `clientId` that isn't yours               |
| `GET /api/pages/:id`            | 200: page, keywords with latest position, issues     | 404                                                      |
| `GET /api/pages/:id/rankings`   | 200 `{ timezone, from, to, series }`                 | 400 `invalid_range`, 404                                 |

`GET /api/pages` takes `clientId`, `q` (URL or keyword), `page` and `pageSize` (at most 100).
`rankings` takes `from` and `to` as dates in the user's time zone: 90 days by default, 730 at
most. A foreign, unknown or malformed id is always 404, never 403.

## Data model

| Table            | Holds                                                    | Keys, constraints, indexes                                                 |
| ---------------- | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `users`          | email, argon2 hash, time zone (`America/Toronto`)        | unique email, checked to be lowercase                                      |
| `sessions`       | SHA-256 of the cookie token, user, expiry                | the raw token is never stored; index on expiry for cleanup                 |
| `clients`        | owner, name, URL, `site_key`, crawl status and progress  | unique `(user_id, site_key)`: one site per user however the URL is written |
| `pages`          | one URL of a client, sitemap position, fetch result      | unique `(client_id, url)`, so a recrawl updates in place; trigram on URL   |
| `keywords`       | normalised search terms, shared by all pages             | unique term; trigram index for search                                      |
| `page_keywords`  | a page's keyword with score, rank and where it was found | unique `(page_id, keyword_id)`                                             |
| `seo_issues`     | code, severity, message, details per page                | unique `(page_id, code)`                                                   |
| `rank_snapshots` | position 1–100, or null when not in the top 100          | PK `(page_keyword_id, snapshot_date)`: one per pair per UTC day            |

`rank_snapshots` also has an index on `(page_keyword_id, captured_at DESC NULLS LAST)`, so the
latest position of a keyword is a single index lookup. Ownership runs user → client → page → page
keyword → snapshot, with cascading deletes. Times are `timestamptz` (UTC); dates shown to the user
are converted in SQL to their time zone.

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
   A blog on its own subdomain (`blog.example.com`) is followed: discovery continues on that host.
2. **Candidates.** Same-site `Sitemap:` lines from robots.txt, judged together with the usual
   sitemap names inside the hub's path (`/blog/sitemap_index.xml`, …): a blog often runs its
   own CMS whose sitemap the main site never lists (Ahrefs). If none of them leads to blog
   posts, the root paths are tried: `/sitemap.xml`, `/sitemap_index.xml`, `/sitemap-index.xml`,
   `/wp-sitemap.xml`, `/sitemap/`, `/blog/sitemap.xml`. Indexes are expanded up to 3 levels deep.
3. **Families.** Sitemaps that differ only by a trailing number belong together
   (`post-sitemap.xml`, `post-sitemap2.xml`).
4. **Score.** Under the hub path +40; `post`/`blog`/`article` in the name +15; `product`, `tag`,
   `author`, `docs` and similar −30. From a sample of up to 500 URLs: mostly under the hub +40,
   lists the hub +40, mostly article-shaped (multi-word slugs, `/yyyy/mm/`) +10.
   Name words come from the file name (`post-sitemap.xml`); the folder counts only when the file
   name says nothing (`/blog/sitemap/`), so `/blog/atl_links-sitemap.xml` doesn't pass for posts.
   A family with none of these signs (a blog-like name, at least 5 URLs under the hub,
   article-shaped URLs) is never taken as the blog, even when it is the only readable sitemap.
   A split sitemap (`partition-0…8.xml`) is read part by part, up to 10, until hub URLs show up.
5. **Posts.** The first 15 URLs of the best family in sitemap order, skipping the hub, archives
   (`/category/`, `/tag/`, `/page/2`), files and other hosts.
   Without a hub, a sitemap that mixes everything is narrowed to its posts section: a blog-word
   path (`/blog/`) or the first path segment most URLs share (`/p/` on Substack). A translated
   sitemap (`/fr/blog/`) loses to the default language when both exist.
   A generic sitemap with no hub and no posts section (a whole site's pages) is not taken as a
   blog: that ends as `no_blog_found` rather than crawling promo pages.

### Tested on real sites

`pnpm --filter @tracker/api discover <url>` was run against 21 sites of different kinds. Each miss
found on the way became a fixture test in `discovery.test.ts`.

| Kind                                 | Sites                                                                 | Result                         |
| ------------------------------------ | --------------------------------------------------------------------- | ------------------------------ |
| WordPress (Yoast, core sitemaps)     | yoast, backlinko, wpbeginner, wordpress.org/news, searchenginejournal | posts sitemap found            |
| Blog sitemap only next to the hub    | ahrefs (`/blog/sitemap_index.xml`, slow 2.6 MB file)                  | found                          |
| Section sitemaps / one mixed sitemap | semrush (`/blog/sitemap/`), vercel, moz, notion (+ `/fr/` copy)       | found                          |
| Split or CDN-hosted sitemaps         | stripe (`partition-0…8`), webflow (CloudFront)                        | found                          |
| Several sitemaps in the blog folder  | atlassian (posts vs links, quizzes)                                   | posts chosen                   |
| Blog on a subdomain                  | hubspot (`blog.hubspot.com`)                                          | found                          |
| Other platforms                      | ghost, allbirds (Shopify), lennysnewsletter (Substack `/p/`)          | found                          |
| Bot protection                       | neilpatel                                                             | `blocked_by_site`              |
| No blog / no sitemap                 | example.com, iana.org, ukrposhta                                      | `no_sitemap` / `no_blog_found` |

## Crawling: what can go wrong

| Situation                              | Handling                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| robots.txt disallows a URL             | Listed as `skipped_robots`, never fetched.                                                             |
| Crawl-delay in robots.txt              | Honoured, capped at 5 s (Semrush asks for 20 s, i.e. 5 minutes per crawl).                             |
| 429, 5xx or a timeout                  | Retried with backoff, honouring `Retry-After` up to 30 s.                                              |
| 403/429 or a bot challenge             | Page marked `blocked`; after 3 in a row the crawl stops as `partial` with `blocked_by_site`.           |
| One page fails                         | Saved with an `http_error` issue; on a recrawl its keywords and history are kept.                      |
| Huge, gzip-bombed or looping responses | 5 MB page / 50 MB sitemap cap after decompression, 5 redirects, clear error codes.                     |
| A large sitemap arrives slowly         | Sitemaps get 60 s per attempt (pages 15 s); only the first 500 URLs are read, then the download stops. |
| Private or internal address            | Rejected on input and on every DNS lookup and redirect hop.                                            |
| The API stops or crashes mid-crawl     | State lives on the client row. A heartbeat every 30 s; crawls silent for 2 minutes are resumed.        |
| Graceful shutdown                      | Handed back to `pending` after the current page; one stopped mid-discovery resumes once stale.         |
| Two crawls at once                     | An atomic claim (`UPDATE … WHERE status = 'pending'`) lets only one runner take a crawl.               |

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
