import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

const healthResponse = z.object({
  status: z.enum(['ok', 'unavailable']),
  database: z.enum(['up', 'down']),
});

export function healthRoutes(checkDatabase: () => Promise<void>): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/health',
      { schema: { response: { 200: healthResponse, 503: healthResponse } } },
      async (request, reply) => {
        try {
          await checkDatabase();
          return { status: 'ok' as const, database: 'up' as const };
        } catch (error) {
          request.log.warn({ err: error }, 'database health check failed');
          return reply.code(503).send({ status: 'unavailable', database: 'down' });
        }
      },
    );
  };
}
