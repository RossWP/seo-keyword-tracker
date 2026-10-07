# SEO Keyword Tracker

Internal tool for an SEO agency. Add a client's website. The app finds the site's blog sitemap
on its own, crawls the first 15 posts and extracts keywords and SEO issues from them. It then
shows each page's daily rank positions in the user's time zone (Toronto).

## Quick start

You need Node 24 (`nvm use`), pnpm 12 (`npm i -g pnpm@12`) and Docker. The seed crawls
semrush.com and yoast.com, so it also needs internet access; it takes about 1–2 minutes.

```bash
pnpm install
docker compose up -d --wait db   # Postgres 18 on localhost:5433
pnpm seed                        # migrations, 2 users, 2 clients, live crawl, ≥50k snapshots
pnpm dev                         # web http://localhost:5173 · API http://localhost:3000
```

To run everything in containers instead:

```bash
docker compose up -d --build --wait
docker compose exec api node dist/seed/seed.js
```


| Account             | Password        | Client      |
| ------------------- | --------------- | ----------- |
| `alice@agency.test` | `demo-password` | semrush.com |
| `bob@agency.test`   | `demo-password` | yoast.com   |

- `.env` is optional; every value has a default (see `.env.example`).
- `pnpm seed` is safe to re-run. `pnpm seed --recrawl` crawls both clients again.
- To reset, run `docker compose down -v`.
- `pnpm --filter @tracker/api discover <url>` prints what discovery would pick for any site, without saving anything.

## What's implemented

- ✅ **Seed:** 2 users, one client each. The 15 posts per client are crawled live. The seed writes 87,600 snapshots for 240 page–keyword pairs and fails if it writes fewer than 50,000.
- ✅ **Blog sitemap found generically**, with no site-specific code (see below). Posts are taken in sitemap order.
- ✅ **Keywords:** up to 8 per page. Each keyword records where it was found (title, H1, slug, headings, body).
- ✅ **SEO issues:** 13 rules plus `http_error`, each marked error or warning. Examples: noindex, missing or duplicate title, title length, missing meta description, missing or multiple H1, missing or mismatched canonical, thin content, client-rendered page, images without alt, mixed content.
- ✅ **Rank snapshots:** stored as UTC `timestamptz`. Every date and date range is converted to the user's time zone (`America/Toronto`) in SQL, so DST is handled. Tests cover the DST change.
- ✅ **Auth:** session cookie (`httpOnly`, `SameSite=Lax`, 7-day sliding expiry; only a SHA-256 of the token is stored). Sessions survive a page refresh. Logins are rate-limited, and state-changing requests have an Origin check.
- ✅ **Isolation:** every query is scoped to the signed-in user. A foreign, unknown or malformed id returns **404, never 403**, so ids can't be probed. Tests run as two users.
- ✅ **Pages list:** client filter, search by URL or keyword (trigram indexes), pagination and the latest position. Filters live in the URL, so they survive refresh, links and Back.
- ✅ **Page detail:** keywords, issues, and a position-history chart with a table view. The date range picker defaults to 90 days and allows up to 730.
- ✅ **Add client:**
  - Invalid URLs are rejected, and so are private or internal hosts (SSRF).
  - Adding the same site twice for one user returns 409; `www.`, scheme and trailing slash don't count as differences, and this is enforced by a DB unique index.
  - The response is `202` and the crawl runs in the background. Its progress shows on the Clients page.
  - A site with no sitemap or no blog ends as `failed` with a readable reason, and can be retried.

## How the blog sitemap is found

1. **Find the blog hub.** Fetch the homepage, following redirects, and look for a "Blog"-like
   link, preferring one in the header or nav.
2. **Collect sitemap candidates.** Read `Sitemap:` lines in robots.txt and try the usual paths
   (`/sitemap.xml`, `/sitemap_index.xml`, `/wp-sitemap.xml`, …). Expand sitemap indexes up to 3 levels deep.
3. **Group candidates into families.** Sitemaps that differ only by a trailing number belong
   together (`post-sitemap.xml` and `post-sitemap2.xml`).
4. **Score each family.** Points come from:
   - the URL sitting under the hub path;
   - name tokens: `post`, `blog`, `article` count for it; `product`, `tag`, `author`, `docs` and similar count against it;
   - a sample of up to 500 URLs: whether most sit under the hub and whether they look like articles (multi-word slugs, `/yyyy/mm/` paths).
5. **Pick the first 15 posts** from the best family, in sitemap order. The hub page, archives
   (`/category/`, `/tag/`, `/page/2`), files and other hosts are skipped.

On the demo sites this picks `semrush.com/blog/sitemap/` and Yoast's `post-sitemap*.xml`.

## Crawling: what can go wrong and what happens

| Situation                                            | Handling                                                                                                                                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| robots.txt disallows a URL                           | The URL is listed as `skipped_robots` and never fetched.                                                                                                                                           |
| robots.txt sets a Crawl-delay                        | The delay is honoured, capped at 5 s (Semrush asks for 20 s, which would mean 5 min per crawl).                                                                                                    |
| HTTP 429/5xx or a timeout                            | Retried with backoff, honouring `Retry-After` up to 30 s.                                                                                                                                          |
| HTTP 403/429 or a Cloudflare challenge               | The page is marked `blocked`. After 3 in a row the crawl stops as `partial` with `blocked_by_site`.                                                                                                |
| A single page fails                                  | That page is saved with an `http_error` issue. The crawl continues and ends as `partial`.                                                                                                          |
| Oversized, gzip-bombed or redirect-looping responses | Size cap, redirect limit and a clear error.                                                                                                                                                        |
| The API restarts mid-crawl                           | The job state lives on the client row and jobs are claimed atomically with a heartbeat. Stale jobs are resumed at boot and every minute. On shutdown the running job is aborted back to `pending`. |

## Key decisions & trade-offs

- **Crawl job state lives on the `clients` row, run in-process.** There's no queue to install, and restarts are safe. The cost: one API instance. More instances would need a jobs table with leases, or pg-boss.
- **Keywords are scored by placement and TF-IDF, not taken from an SEO API.** The weight depends on where a phrase appears, with a bonus for 2–3 word phrases. Phrases are discounted when they're common across the site, and the brand name (the shared title suffix) is removed. The result is explainable and free; an API like Semrush's would be more accurate, at a cost per call.
- **Rank data is generated, not real.** The generator is deterministic (seeded by page and keyword), so every machine sees the same numbers. Positions follow a mean-reverting random walk with shared "algorithm update" days, and about 5% of days fall outside the top 100 (`null`). History length is computed so the total passes 50k.
- **Snapshots are captured at 02:30 UTC.** That time is the previous evening in Toronto, so a wrong time-zone conversion would show up as an off-by-one day; tests check this.
- **Drizzle and SQL.** Drizzle supplies typed schema and migrations. Hot queries are plain SQL; for example, the latest position is a lateral join on an index sorted `DESC NULLS LAST`, which took the pages query from 18 ms to 5 ms.
- **Fastify with Zod on every boundary.** Requests, DB rows and API responses in the web app are all validated. Errors use one shape: `{ error: { code, message, details } }`.

## Assumptions

- The user's time zone is a per-user setting, defaulting to `America/Toronto`; there is no UI to change it.
- A position of `null` means "not in the top 100" and appears as a gap in the chart.
- "First 15 posts" means the first 15 in the sitemap, not the newest.
- New clients get crawled pages, keywords and issues, but no rank history; the brief only requires snapshots in the seed.

## Testing

`pnpm check` runs formatting, lint, typecheck and all tests. It needs the db container running.

- **API (151 tests):** run against a real Postgres `<db>_test` database that is recreated on each run.
  - Auth, isolation, validation and the HTTP contract of every route.
  - Time zone and DST ranges.
  - Discovery and crawl, against a local fixture HTTP server (no live sites).
  - Keyword and issue rules; the rank generator.
- **Web (30 tests):** Testing Library with a fake API. Covers login, protected routes, URL-synced filters, the add-client form errors and the chart.
- **Manual:** live discovery and seed on semrush.com and yoast.com.

## Known weak spots

- A recrawl doesn't remove pages that have dropped out of the sitemap's first 15. They stay, with their history, alongside the new ones.
- Pages that robots.txt now disallows keep the keywords from their last successful crawl.
- Keyword scores use IDF across the client's pages, so recrawling one page can change another page's keywords.

## What I'd do next

- **Rank data:** a real rank provider such as DataForSEO or the Semrush API, called from a daily scheduled job instead of the seed.
- **Live updates:** SSE for crawl progress instead of polling every 3 s.
- **More API instances:** a jobs table with leases.
- **Crawling:** a headless browser for client-rendered sites (today they're only flagged); non-English stopwords.
- **Time zone:** let the user change it in the UI.
- **Security:** CSRF tokens in addition to the Origin check (requests without an `Origin` header pass today; `SameSite=Lax` covers them). Login rate limit per IP as well as per IP+email, with `trustProxy` set behind nginx.
- **Delivery:** CI running `pnpm check` and the Docker build; OpenAPI docs; e2e tests with Playwright.

## Time spent & AI usage

- **Time:** about 5 hours.
- **Tools:** Claude (Claude Code, Opus).
- **What it produced:** most of the code, the tests and this README, slice by slice from a plan I approved.
- **What I decided and changed:**
  - I set the stack, scope and cut list.
  - I reviewed every change before committing it.
  - I ran the real crawls; their results led to the keyword phrase rules and the brand filter.
  - Version pins: TypeScript 6, because typescript-eslint does not support TypeScript 7 yet.
- **How I checked it:**
  - The test suite above.
  - Live crawls of both sites.
  - Clicking through the UI in a desktop browser and at phone width.
  - A query plan check, which found the index sort-order mismatch.
  - An independent review by a separate Claude agent that hadn't seen the build. It checked the code against the brief, and its findings led to these fixes:
    - a failed recrawl no longer deletes a page's rank history;
    - nested sitemap indexes are followed;
    - a broken robots.txt sitemap falls back to the usual locations;
    - `max-image-preview:none` is no longer reported as noindex;
    - the page list refreshes when a crawl finishes.
