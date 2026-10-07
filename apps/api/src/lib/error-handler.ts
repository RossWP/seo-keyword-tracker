import type { FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { AppError, errorBody } from './errors.js';

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    return reply
      .code(404)
      .send(errorBody('not_found', `Route ${request.method} ${request.url} not found`));
  });

  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      const issues = error.validation.map((issue) => ({
        path: [error.validationContext, ...issue.instancePath.split('/').filter(Boolean)]
          .filter(Boolean)
          .join('.'),
        message: issue.message,
      }));
      return reply
        .code(400)
        .send(errorBody('validation_error', 'Request validation failed', { issues }));
    }

    if (error instanceof AppError) {
      return reply.code(error.statusCode).send(errorBody(error.code, error.message, error.details));
    }

    // Fastify's own client errors: malformed JSON, payload too large, unsupported media type.
    if (isClientError(error)) {
      return reply.code(error.statusCode).send(errorBody('bad_request', error.message));
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send(errorBody('internal_error', 'Something went wrong'));
  });
}

function isClientError(error: unknown): error is { statusCode: number; message: string } {
  if (!(error instanceof Error) || !('statusCode' in error)) return false;
  const { statusCode } = error;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500;
}
