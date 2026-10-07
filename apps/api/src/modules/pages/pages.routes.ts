import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';
import { isUuid } from '../../lib/ids.js';
import { currentUser, requireUser } from '../auth/auth.plugin.js';
import { findOwnClient } from '../clients/clients.repository.js';
import { countPages, findOwnPage, listPages, pageHistory } from './pages.repository.js';

const listQuery = z.object({
  clientId: z.string().optional(),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const keywordSummary = z.object({
  id: z.number(),
  term: z.string(),
  /** Most recent position; null = not in the top 100 that day, or no history yet. */
  position: z.number().nullable(),
  /** Day of that snapshot in the user's time zone. */
  date: z.string().nullable(),
});

const pageListItem = z.object({
  id: z.uuid(),
  url: z.string(),
  title: z.string().nullable(),
  fetchStatus: z.string(),
  client: z.object({ id: z.uuid(), name: z.string() }),
  issueCount: z.number(),
  errorCount: z.number(),
  bestPosition: z.number().nullable(),
  keywords: z.array(keywordSummary),
});

const listResponse = z.object({
  items: z.array(pageListItem),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export function pageRoutes(db: Database): FastifyPluginAsyncZod {
  return async (app) => {
    app.addHook('onRequest', requireUser);

    app.get(
      '/',
      { schema: { querystring: listQuery, response: { 200: listResponse } } },
      async (request) => {
        const user = currentUser(request);
        const { clientId, q, page, pageSize } = request.query;
        if (clientId !== undefined) {
          // Another user's client (or a made-up id) is "not found", never an empty list.
          if (!isUuid(clientId) || !(await findOwnClient(db, user.id, clientId))) {
            throw new AppError(404, 'not_found', 'Client not found');
          }
        }
        const filter = {
          userId: user.id,
          timezone: user.timezone,
          clientId,
          search: q === '' ? undefined : q,
          limit: pageSize,
          offset: (page - 1) * pageSize,
        };
        const [total, rows] = await Promise.all([countPages(db, filter), listPages(db, filter)]);
        return {
          page,
          pageSize,
          total,
          items: rows.map(({ clientId: id, clientName, ...row }) => ({
            ...row,
            client: { id, name: clientName },
            bestPosition: best(row.keywords.map((keyword) => keyword.position)),
          })),
        };
      },
    );

    app.get(
      '/:id',
      { schema: { params: pageParams, response: { 200: pageDetail } } },
      async (request) => {
        const user = currentUser(request);
        const page = await loadOwnPage(db, user, request.params.id);
        const { clientId, clientName, ...rest } = page;
        return { ...rest, client: { id: clientId, name: clientName } };
      },
    );

    app.get(
      '/:id/rankings',
      {
        schema: {
          params: pageParams,
          querystring: historyQuery,
          response: { 200: historyResponse },
        },
      },
      async (request) => {
        const user = currentUser(request);
        const page = await loadOwnPage(db, user, request.params.id);
        const to = request.query.to ?? todayIn(user.timezone);
        const from = request.query.from ?? addDays(to, -(DEFAULT_RANGE_DAYS - 1));
        const span = daysBetween(from, to);
        if (span < 0) throw new AppError(400, 'invalid_range', '"from" must not be after "to"');
        if (span >= MAX_RANGE_DAYS) {
          throw new AppError(400, 'invalid_range', `Pick at most ${MAX_RANGE_DAYS} days`);
        }

        const points = await pageHistory(db, {
          pageId: page.id,
          timezone: user.timezone,
          from,
          to,
        });
        return {
          timezone: user.timezone,
          from,
          to,
          series: page.keywords.map((keyword) => ({
            keywordId: keyword.id,
            term: keyword.term,
            points: points
              .filter((point) => point.keywordId === keyword.id)
              .map(({ date, position }) => ({ date, position })),
          })),
        };
      },
    );
  };
}

async function loadOwnPage(db: Database, user: { id: string; timezone: string }, pageId: string) {
  const page = isUuid(pageId)
    ? await findOwnPage(db, { userId: user.id, pageId, timezone: user.timezone })
    : undefined;
  if (!page) throw new AppError(404, 'not_found', 'Page not found');
  return page;
}

/** Today's calendar date in a time zone, e.g. still "2026-10-06" at 23:00 in Toronto. */
function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
}

const DAY_MS = 24 * 60 * 60 * 1000;
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

const isoDate = z.iso.date();
const MAX_RANGE_DAYS = 730;
const DEFAULT_RANGE_DAYS = 90;

const pageDetail = z.object({
  id: z.uuid(),
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
  client: z.object({ id: z.uuid(), name: z.string() }),
  keywords: z.array(keywordSummary.extend({ score: z.number(), sources: z.array(z.string()) })),
  issues: z.array(
    z.object({
      code: z.string(),
      severity: z.enum(['error', 'warning', 'notice']),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).nullable(),
    }),
  ),
});

const historyQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() });

const historyResponse = z.object({
  timezone: z.string(),
  from: isoDate,
  to: isoDate,
  series: z.array(
    z.object({
      keywordId: z.number(),
      term: z.string(),
      points: z.array(z.object({ date: isoDate, position: z.number().nullable() })),
    }),
  ),
});

const pageParams = z.object({ id: z.string() });

function best(positions: (number | null)[]): number | null {
  const ranked = positions.filter((position): position is number => position !== null);
  return ranked.length > 0 ? Math.min(...ranked) : null;
}
