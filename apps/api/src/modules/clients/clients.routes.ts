import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { assertPublicLiteral } from '../../crawler/ssrf.js';
import type { Database } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';
import { isUuid } from '../../lib/ids.js';
import { parseWebsiteUrl } from '../../lib/url.js';
import { currentUser, requireUser } from '../auth/auth.plugin.js';
import {
  findClientBySiteKey,
  findOwnClient,
  insertClient,
  listClients,
  requeueClient,
} from './clients.repository.js';

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

const createBody = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(100),
  websiteUrl: z.string().trim().min(1, 'Enter the website URL').max(2000),
});

const idParams = z.object({ id: z.string() });

/** One field error in the same shape as schema validation errors, so the form maps it the same way. */
const fieldError = (code: string, message: string) =>
  new AppError(400, code, message, { issues: [{ path: 'body.websiteUrl', message }] });

export function clientRoutes(
  db: Database,
  enqueueCrawl: (clientId: string) => void,
): FastifyPluginAsyncZod {
  return async (app) => {
    app.addHook('onRequest', requireUser);

    app.get(
      '/',
      { schema: { response: { 200: z.object({ items: z.array(clientSchema) }) } } },
      async (request) => ({ items: await listClients(db, currentUser(request).id) }),
    );

    app.post(
      '/',
      { schema: { body: createBody, response: { 202: clientSchema } } },
      async (request, reply) => {
        const user = currentUser(request);
        const website = parseWebsiteUrl(request.body.websiteUrl);
        if (!website) {
          throw fieldError('invalid_url', 'Enter a full website address, like https://example.com');
        }
        try {
          assertPublicLiteral(new URL(website.url).hostname);
        } catch {
          throw fieldError('blocked_host', 'Private and internal addresses cannot be crawled');
        }

        // The owner always comes from the session, never from the request body.
        const client = await insertClient(db, {
          userId: user.id,
          name: request.body.name,
          websiteUrl: website.url,
          siteKey: website.siteKey,
        });
        if (!client) {
          const existing = await findClientBySiteKey(db, user.id, website.siteKey);
          throw new AppError(
            409,
            'duplicate_site',
            `You already track this site as "${existing?.name ?? ''}"`,
            {
              clientId: existing?.id,
            },
          );
        }

        enqueueCrawl(client.id);
        return reply.code(202).header('location', `/api/clients/${client.id}`).send(client);
      },
    );

    app.get(
      '/:id',
      { schema: { params: idParams, response: { 200: clientSchema } } },
      async (request) => {
        const { id } = request.params;
        const client = isUuid(id)
          ? await findOwnClient(db, currentUser(request).id, id)
          : undefined;
        if (!client) throw new AppError(404, 'not_found', 'Client not found');
        return client;
      },
    );

    app.post(
      '/:id/recrawl',
      { schema: { params: idParams, response: { 202: clientSchema } } },
      async (request, reply) => {
        const user = currentUser(request);
        const { id } = request.params;
        if (!isUuid(id)) throw new AppError(404, 'not_found', 'Client not found');
        const client = await requeueClient(db, user.id, id);
        if (!client) {
          if (await findOwnClient(db, user.id, id)) {
            throw new AppError(409, 'crawl_in_progress', 'This client is already being crawled');
          }
          throw new AppError(404, 'not_found', 'Client not found');
        }
        enqueueCrawl(client.id);
        return reply.code(202).header('location', `/api/clients/${client.id}`).send(client);
      },
    );
  };
}
