# SEO Keyword Tracker

Add a client's website. The app finds its blog sitemap on its own, crawls the first 15 posts,
extracts keywords and SEO issues, and shows daily rank positions in the user's time zone
(Toronto). Project structure, API, data model and design details are in
[docs/design.md](docs/design.md).

## How to run it

Needs Node 24 (`nvm use`), pnpm 12 (`npm i -g pnpm@12`), Docker, and internet access (the seed
crawls semrush.com and yoast.com, about 1–2 minutes).

Everything in Docker, then the seed; open http://localhost:8080:

```bash
pnpm start
```

For development (Postgres in Docker, the seed, then dev servers on http://localhost:5173):

```bash
pnpm install
pnpm start:dev
```

`pnpm start` runs `docker compose up -d --build --wait`, then the seed inside the API container.
`pnpm start:dev` runs `docker compose up -d --wait db`, `pnpm seed` (migrations, 2 users, 2
clients, live crawl, ≥50k snapshots) and `pnpm dev`. `pnpm reset` deletes the database volume.

Sign in as `alice@agency.test` (Semrush) or `bob@agency.test` (Yoast), password `demo-password`.
`.env` is optional (see `.env.example`). `pnpm seed` is safe to re-run; `--recrawl` crawls again.
`pnpm check` runs format, lint, typecheck and all tests (needs the db container).

## Decisions and why

- **Blog sitemap, found generically.** No site-specific code: a "Blog" link on the homepage,
  robots.txt and the usual sitemap paths, sitemap names and the shape of their URLs are scored
  together. Semrush resolves to `/blog/sitemap/`, Yoast to `post-sitemap*.xml`.
- **Keywords by placement and TF-IDF.** Phrases score by where they appear (title, H1, slug,
  headings), favour 2–3 words, sink when common across the site, and drop the brand name.
  Explainable and free; the UI shows where each keyword was found.
- **Crawls run in the background with their state on the client row.** `POST` returns 202; an
  atomic claim, a heartbeat and resume-on-boot make restarts safe, with no queue to install.
- **UTC storage, Toronto display.** Snapshots are `timestamptz`; dates and ranges convert in SQL
  with `AT TIME ZONE`, so DST is handled. Captures at 02:30 UTC (the previous evening in
  Toronto) make any conversion mistake show up as an off-by-one day in tests.
- **Isolation in every query.** The owner always comes from the session; a foreign, unknown or
  malformed id is 404, never 403. Duplicate sites are blocked by a unique index.
- **Responsive at 50k+ rows.** Indexes match the hot queries (the latest position is one index
  lookup), with server-side pagination; the list query takes about 5 ms.
- **Crawler safety.** Private and internal addresses are blocked on every DNS lookup and redirect;
  robots.txt is honoured (Crawl-delay capped at 5 s); retries, timeouts and size limits.
- **Positions are invented** by a deterministic random walk, so every machine sees the same data.

## Unfinished, and what I'd do next

- A recrawl keeps pages that have left the sitemap's first 15, and replaces a page's keyword set,
  which drops the history of keywords no longer picked. Next: keep retired keywords as inactive.
- One API instance (the crawl queue is in-process). Next: a jobs table with leases, or pg-boss.
- Positions are invented. Next: a rank provider such as DataForSEO on a daily scheduled job.
- Client-rendered sites are flagged, not rendered; stopwords are English only.
- Progress is polled every 3 s; SSE would be nicer. No UI to change the time zone.
- No CI yet: `pnpm check` and the Docker build on every push, plus Playwright e2e tests.

## Time and AI tools

About 5 hours. Claude (Claude Code, Opus) wrote most of the code, tests and docs, slice by slice
from a plan I approved; I set the stack and scope, reviewed every change, ran the live crawls
(which shaped the keyword rules) and checked the result with tests, a query plan and the UI.
A second Claude agent with no build context reviewed the repo against the brief; its findings
became separate fix commits.
