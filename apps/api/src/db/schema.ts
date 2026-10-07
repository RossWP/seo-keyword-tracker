import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const crawlStatus = pgEnum('crawl_status', [
  'pending',
  'discovering',
  'crawling',
  'done',
  'partial',
  'failed',
]);
export const fetchStatus = pgEnum('fetch_status', ['ok', 'failed', 'blocked', 'skipped_robots']);
export const issueSeverity = pgEnum('issue_severity', ['error', 'warning', 'notice']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Stored lowercased by the app; the check keeps the unique index case-insensitive.
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    timezone: text('timezone').notNull().default('America/Toronto'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('users_email_key').on(t.email),
    check('users_email_lowercase', sql`${t.email} = lower(${t.email})`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    // SHA-256 of the cookie token; the raw token is never stored.
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_expires_at_idx').on(t.expiresAt),
  ],
);

export const clients = pgTable(
  'clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    websiteUrl: text('website_url').notNull(),
    // Host without "www.", lowercased and punycoded: one site per user regardless of URL spelling.
    siteKey: text('site_key').notNull(),
    crawlStatus: crawlStatus('crawl_status').notNull().default('pending'),
    crawlErrorCode: text('crawl_error_code'),
    crawlErrorMessage: text('crawl_error_message'),
    sitemapUrl: text('sitemap_url'),
    discoveryMethod: text('discovery_method'),
    pagesTotal: integer('pages_total').notNull().default(0),
    pagesDone: integer('pages_done').notNull().default(0),
    crawlStartedAt: timestamp('crawl_started_at', { withTimezone: true }),
    crawlFinishedAt: timestamp('crawl_finished_at', { withTimezone: true }),
    crawlHeartbeatAt: timestamp('crawl_heartbeat_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('clients_user_site_key').on(t.userId, t.siteKey),
    index('clients_crawl_status_idx').on(t.crawlStatus),
    check('clients_pages_progress', sql`${t.pagesDone} between 0 and ${t.pagesTotal}`),
  ],
);

export const pages = pgTable(
  'pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    sitemapPosition: integer('sitemap_position').notNull(),
    fetchStatus: fetchStatus('fetch_status').notNull(),
    httpStatus: smallint('http_status'),
    finalUrl: text('final_url'),
    title: text('title'),
    metaDescription: text('meta_description'),
    h1: text('h1'),
    wordCount: integer('word_count'),
    lang: text('lang'),
    responseMs: integer('response_ms'),
    fetchError: text('fetch_error'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('pages_client_url_key').on(t.clientId, t.url),
    index('pages_client_position_idx').on(t.clientId, t.sitemapPosition),
    index('pages_url_trgm_idx').using('gin', t.url.op('gin_trgm_ops')),
  ],
);

export const keywords = pgTable(
  'keywords',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    // Normalised: lowercase, NFKC, single spaces. Shared dictionary; ownership goes through pages.
    term: text('term').notNull(),
  },
  (t) => [
    uniqueIndex('keywords_term_key').on(t.term),
    index('keywords_term_trgm_idx').using('gin', t.term.op('gin_trgm_ops')),
  ],
);

export const pageKeywords = pgTable(
  'page_keywords',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    keywordId: bigint('keyword_id', { mode: 'number' })
      .notNull()
      .references(() => keywords.id),
    score: real('score').notNull(),
    rankOrder: smallint('rank_order').notNull(),
    // Where the phrase was found (title, h1, slug, …) so the UI can explain the pick.
    sources: text('sources')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (t) => [
    uniqueIndex('page_keywords_page_keyword_key').on(t.pageId, t.keywordId),
    index('page_keywords_keyword_id_idx').on(t.keywordId),
  ],
);

export const seoIssues = pgTable(
  'seo_issues',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    severity: issueSeverity('severity').notNull(),
    message: text('message').notNull(),
    details: jsonb('details'),
  },
  (t) => [uniqueIndex('seo_issues_page_code_key').on(t.pageId, t.code)],
);

export const rankSnapshots = pgTable(
  'rank_snapshots',
  {
    pageKeywordId: bigint('page_keyword_id', { mode: 'number' })
      .notNull()
      .references(() => pageKeywords.id, { onDelete: 'cascade' }),
    // UTC calendar day of the capture: one snapshot per pair per day.
    snapshotDate: date('snapshot_date').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    // null = not in the top 100 that day.
    position: smallint('position'),
  },
  (t) => [
    primaryKey({ columns: [t.pageKeywordId, t.snapshotDate] }),
    index('rank_snapshots_pair_captured_idx').on(t.pageKeywordId, t.capturedAt.desc()),
    check('rank_snapshots_position_range', sql`${t.position} between 1 and 100`),
  ],
);
