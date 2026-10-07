import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyServerOptions } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { registerErrorHandlers } from './lib/error-handler.js';
import { registerSessionHooks, type CookieSettings } from './modules/auth/auth.plugin.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { clientRoutes } from './modules/clients/clients.routes.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { pageRoutes } from './modules/pages/pages.routes.js';
import type { Database } from './db/client.js';
import type { Services } from './services.js';

export interface AppDeps {
  logger: FastifyServerOptions['logger'];
  checkDatabase: () => Promise<void>;
  services: Services;
  db: Database;
  /** Schedules a background crawl; the crawl state itself is stored on the client row. */
  enqueueCrawl: (clientId: string) => void;
  cookies: CookieSettings;
}

export function buildApp({ logger, checkDatabase, services, db, enqueueCrawl, cookies }: AppDeps) {
  const app = Fastify({
    logger,
    requestIdHeader: 'x-request-id',
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandlers(app);

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  void app.register(helmet);
  void app.register(cookie);
  void app.register(rateLimit, { global: false });
  void app.register(healthRoutes(checkDatabase));

  void app.register(
    async (api) => {
      registerSessionHooks(api, services.auth, cookies);
      await api.register(authRoutes(services.auth, cookies), { prefix: '/auth' });
      await api.register(clientRoutes(db, enqueueCrawl), { prefix: '/clients' });
      await api.register(pageRoutes(db), { prefix: '/pages' });
    },
    { prefix: '/api' },
  );

  return app;
}
