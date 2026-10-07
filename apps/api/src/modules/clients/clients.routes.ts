import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { currentUser, requireUser } from '../auth/auth.plugin.js';
import { listClients } from './clients.repository.js';

export const clientSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  websiteUrl: z.string(),
  crawlStatus: z.enum(['pending', 'discovering', 'crawling', 'done', 'partial', 'failed']),
  crawlErrorCode: z.string().nullable(),
  crawlErrorMessage: z.string().nullable(),
  pagesTotal: z.number().int(),
  pagesDone: z.number().int(),
  sitemapUrl: z.string().nullable(),
  createdAt: z.date(),
  crawlFinishedAt: z.date().nullable(),
});

export function clientRoutes(db: Database): FastifyPluginAsyncZod {
  return async (app) => {
    app.addHook('onRequest', requireUser);

    app.get(
      '/',
      { schema: { response: { 200: z.object({ items: z.array(clientSchema) }) } } },
      async (request) => ({ items: await listClients(db, currentUser(request).id) }),
    );
  };
}
