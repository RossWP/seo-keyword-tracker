import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { containsPattern } from '../../lib/like.js';

export interface PageListFilter {
  userId: string;
  timezone: string;
  clientId?: string;
  search?: string;
  limit: number;
  offset: number;
}

const pageListRow = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string().nullable(),
  fetchStatus: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  issueCount: z.number(),
  errorCount: z.number(),
  keywords: z.array(
    z.object({
      id: z.number(),
      term: z.string(),
      position: z.number().nullable(),
      date: z.string().nullable(),
    }),
  ),
});

export type PageListRow = z.infer<typeof pageListRow>;

/** Ownership, client filter and URL-or-keyword search: shared by the count and the page query. */
function listWhere({ userId, clientId, search }: PageListFilter): SQL {
  const conditions = [sql`c.user_id = ${userId}`];
  if (clientId) conditions.push(sql`c.id = ${clientId}`);
  if (search) {
    const pattern = containsPattern(search);
    conditions.push(sql`(
      p.url ilike ${pattern}
      or exists (
        select 1 from page_keywords pk join keywords k on k.id = pk.keyword_id
        where pk.page_id = p.id and k.term ilike ${pattern}
      )
    )`);
  }
  return sql.join(conditions, sql` and `);
}

export async function countPages(db: Database, filter: PageListFilter): Promise<number> {
  const result = await db.execute<{ total: number }>(sql`
    select count(*)::int as total
    from pages p join clients c on c.id = p.client_id
    where ${listWhere(filter)}`);
  return result.rows[0]?.total ?? 0;
}

/**
 * One page of the list with each keyword's most recent position. The latest snapshot per
 * pair is a single index lookup on (page_keyword_id, captured_at desc), so a 20-row page
 * costs ~160 lookups regardless of how much history exists.
 */
export async function listPages(db: Database, filter: PageListFilter): Promise<PageListRow[]> {
  const result = await db.execute(sql`
    select
      p.id, p.url, p.title, p.fetch_status as "fetchStatus",
      c.id as "clientId", c.name as "clientName",
      (select count(*)::int from seo_issues i where i.page_id = p.id) as "issueCount",
      (select count(*)::int from seo_issues i where i.page_id = p.id and i.severity = 'error') as "errorCount",
      coalesce((
        select json_agg(json_build_object(
          'id', k.id, 'term', k.term, 'position', latest.position,
          'date', to_char(latest.captured_at at time zone ${filter.timezone}, 'YYYY-MM-DD')
        ) order by pk.rank_order)
        from page_keywords pk
        join keywords k on k.id = pk.keyword_id
        left join lateral (
          select rs.position, rs.captured_at from rank_snapshots rs
          where rs.page_keyword_id = pk.id
          order by rs.captured_at desc limit 1
        ) latest on true
        where pk.page_id = p.id
      ), '[]'::json) as keywords
    from pages p join clients c on c.id = p.client_id
    where ${listWhere(filter)}
    order by c.name, c.id, p.sitemap_position
    limit ${filter.limit} offset ${filter.offset}`);
  // Raw SQL with json_agg: the row shape is checked here rather than trusted.
  return z.array(pageListRow).parse(result.rows);
}

const pageDetailRow = z.object({
  id: z.string(),
  url: z.string(),
  finalUrl: z.string().nullable(),
  title: z.string().nullable(),
  metaDescription: z.string().nullable(),
  h1: z.string().nullable(),
  wordCount: z.number().nullable(),
  fetchStatus: z.string(),
  fetchError: z.string().nullable(),
  httpStatus: z.number().nullable(),
  fetchedAt: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  keywords: z.array(
    z.object({
      id: z.number(),
      term: z.string(),
      score: z.number(),
      sources: z.array(z.string()),
      position: z.number().nullable(),
      date: z.string().nullable(),
    }),
  ),
  issues: z.array(
    z.object({
      code: z.string(),
      severity: z.enum(['error', 'warning', 'notice']),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).nullable(),
    }),
  ),
});

export type PageDetail = z.infer<typeof pageDetailRow>;

/** One page with its keywords (latest position each) and issues, only if the user owns it. */
export async function findOwnPage(
  db: Database,
  { userId, pageId, timezone }: { userId: string; pageId: string; timezone: string },
): Promise<PageDetail | undefined> {
  const result = await db.execute(sql`
    select
      p.id, p.url, p.final_url as "finalUrl", p.title, p.meta_description as "metaDescription",
      p.h1, p.word_count as "wordCount", p.fetch_status as "fetchStatus",
      p.fetch_error as "fetchError", p.http_status as "httpStatus",
      to_char(p.fetched_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "fetchedAt",
      c.id as "clientId", c.name as "clientName",
      coalesce((
        select json_agg(json_build_object(
          'id', k.id, 'term', k.term, 'score', pk.score, 'sources', pk.sources,
          'position', latest.position,
          'date', to_char(latest.captured_at at time zone ${timezone}, 'YYYY-MM-DD')
        ) order by pk.rank_order)
        from page_keywords pk
        join keywords k on k.id = pk.keyword_id
        left join lateral (
          select rs.position, rs.captured_at from rank_snapshots rs
          where rs.page_keyword_id = pk.id order by rs.captured_at desc limit 1
        ) latest on true
        where pk.page_id = p.id
      ), '[]'::json) as keywords,
      coalesce((
        select json_agg(json_build_object(
          'code', i.code, 'severity', i.severity, 'message', i.message, 'details', i.details
        ) order by case i.severity when 'error' then 0 when 'warning' then 1 else 2 end, i.code)
        from seo_issues i where i.page_id = p.id
      ), '[]'::json) as issues
    from pages p join clients c on c.id = p.client_id
    where p.id = ${pageId} and c.user_id = ${userId}`);
  const [row] = result.rows;
  return row ? pageDetailRow.parse(row) : undefined;
}

const historyPoint = z.object({
  keywordId: z.number(),
  date: z.string(),
  position: z.number().nullable(),
});

/**
 * Rank history for one page between two calendar days in the user's time zone, inclusive.
 * The local range becomes a half-open UTC interval [from 00:00, to+1 00:00) in that zone, so
 * DST days (23 or 25 hours) are handled by Postgres, and the filter stays on the raw
 * captured_at column, which keeps the (page_keyword_id, captured_at) index usable.
 */
export async function pageHistory(
  db: Database,
  { pageId, timezone, from, to }: { pageId: string; timezone: string; from: string; to: string },
) {
  const result = await db.execute(sql`
    select pk.keyword_id::int as "keywordId",
           to_char(rs.captured_at at time zone ${timezone}, 'YYYY-MM-DD') as date,
           rs.position
    from page_keywords pk
    join rank_snapshots rs on rs.page_keyword_id = pk.id
    where pk.page_id = ${pageId}
      and rs.captured_at >= (${from}::date)::timestamp at time zone ${timezone}
      and rs.captured_at < (${to}::date + 1)::timestamp at time zone ${timezone}
    order by pk.rank_order, rs.captured_at`);
  return z.array(historyPoint).parse(result.rows);
}
