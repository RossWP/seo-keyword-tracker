import helmet from '@fastify/helmet';
import Fastify, { type FastifyServerOptions } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { registerErrorHandlers } from './lib/error-handler.js';
import { healthRoutes } from './modules/health/health.routes.js';

export interface AppDeps {
  logger: FastifyServerOptions['logger'];
  checkDatabase: () => Promise<void>;
}

export function buildApp({ logger, checkDatabase }: AppDeps) {
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
  void app.register(healthRoutes(checkDatabase));

  return app;
}
