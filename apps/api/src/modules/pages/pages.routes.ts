import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';
import { isUuid } from '../../lib/ids.js';
import { currentUser, requireUser } from '../auth/auth.plugin.js';
import { findOwnClient } from '../clients/clients.repository.js';
import { countPages, listPages } from './pages.repository.js';

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
  };
}

function best(positions: (number | null)[]): number | null {
  const ranked = positions.filter((position): position is number => position !== null);
  return ranked.length > 0 ? Math.min(...ranked) : null;
}
