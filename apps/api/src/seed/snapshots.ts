import { asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { keywords, pageKeywords, pages, rankSnapshots } from '../db/schema.js';
import { generateSeries } from './rank-generator.js';

const BATCH_SIZE = 10_000;

/** Every page–keyword pair of every user, in a stable order. */
export async function loadPairs(db: Database) {
  return db
    .select({
      id: pageKeywords.id,
      rankOrder: pageKeywords.rankOrder,
      url: pages.url,
      term: keywords.term,
    })
    .from(pageKeywords)
    .innerJoin(pages, eq(pages.id, pageKeywords.pageId))
    .innerJoin(keywords, eq(keywords.id, pageKeywords.keywordId))
    .orderBy(asc(pageKeywords.id));
}

/**
 * Generates history for each pair over `dates` and inserts it. Existing (pair, day) rows are
 * kept, so re-running only fills gaps: new pairs get full history, old pairs get new days.
 */
export async function fillSnapshots(
  db: Database,
  pairs: Awaited<ReturnType<typeof loadPairs>>,
  dates: string[],
): Promise<number> {
  let inserted = 0;
  let batch: { ids: number[]; dates: string[]; captured: Date[]; positions: (number | null)[] } =
    empty();

  const flush = async () => {
    if (batch.ids.length === 0) return;
    // unnest() turns four array parameters into rows: one round trip per 10k rows. Raw driver
    // call, because the query builder would expand each array into thousands of parameters.
    const result = await db.$client.query(
      `insert into rank_snapshots (page_keyword_id, snapshot_date, captured_at, position)
       select * from unnest($1::bigint[], $2::date[], $3::timestamptz[], $4::smallint[])
       on conflict do nothing`,
      [batch.ids, batch.dates, batch.captured, batch.positions],
    );
    inserted += result.rowCount ?? 0;
    batch = empty();
  };

  for (const pair of pairs) {
    for (const row of generateSeries(`${pair.url}|${pair.term}`, pair.rankOrder, dates)) {
      batch.ids.push(pair.id);
      batch.dates.push(row.snapshotDate);
      batch.captured.push(row.capturedAt);
      batch.positions.push(row.position);
      if (batch.ids.length >= BATCH_SIZE) await flush();
    }
  }
  await flush();
  await db.execute(sql`analyze ${rankSnapshots}`);
  return inserted;
}

export async function countSnapshots(db: Database): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(rankSnapshots);
  return row?.count ?? 0;
}

function empty() {
  return {
    ids: [] as number[],
    dates: [] as string[],
    captured: [] as Date[],
    positions: [] as (number | null)[],
  };
}
