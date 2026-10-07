# SEO Keyword Tracker

Internal tool for an SEO agency: add a client's website, find its blog sitemap, crawl the first 15
blog posts, extract keywords and SEO issues, and track daily rank positions.

Work in progress — setup instructions, decisions and the cut list will be added as the build
progresses.

## Stack

- **API:** Node.js 24, TypeScript, Fastify, PostgreSQL (Drizzle)
- **Web:** React, Vite, TanStack Query
- **Tooling:** pnpm workspaces, ESLint (type-aware), Prettier, Vitest

## Development

Requires Node 24 (`nvm use`) and pnpm 12 (`npm install --global pnpm@12`; pnpm switches to the
exact version pinned in `package.json` on its own).

```bash
pnpm install
pnpm check   # format check, lint, typecheck, tests
```
