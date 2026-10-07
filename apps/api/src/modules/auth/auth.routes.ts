import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { normalizeEmail } from '../users/users.repository.js';
import {
  clearSessionCookie,
  currentUser,
  requireUser,
  SESSION_COOKIE,
  setSessionCookie,
  type CookieSettings,
} from './auth.plugin.js';
import type { AuthService } from './auth.service.js';

const userResponse = z.object({
  user: z.object({ id: z.uuid(), email: z.string(), timezone: z.string() }),
});

const loginBody = z.object({
  email: z.string().trim().pipe(z.email().max(254)),
  password: z.string().min(1).max(200),
});

export function authRoutes(auth: AuthService, cookies: CookieSettings): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/login',
      {
        schema: { body: loginBody, response: { 200: userResponse } },
        config: {
          rateLimit: {
            max: 5,
            timeWindow: '1 minute',
            // After validation, so the key can include the email: one IP can't lock out everyone.
            hook: 'preHandler',
            keyGenerator: (request) => {
              const { email } = request.body as z.infer<typeof loginBody>;
              return `${request.ip}:${normalizeEmail(email)}`;
            },
            errorResponseBuilder: () =>
              new AppError(
                429,
                'rate_limited',
                'Too many sign-in attempts. Try again in a minute.',
              ),
          },
        },
      },
      async (request, reply) => {
        const { user, session } = await auth.login(request.body.email, request.body.password);
        setSessionCookie(reply, session.token, session.expiresAt, cookies);
        return { user };
      },
    );

    app.post('/logout', async (request, reply) => {
      const token = request.cookies[SESSION_COOKIE];
      if (token) await auth.logout(token);
      clearSessionCookie(reply, cookies);
      return reply.code(204).send();
    });

    app.get(
      '/me',
      { onRequest: requireUser, schema: { response: { 200: userResponse } } },
      async (request) => ({ user: currentUser(request) }),
    );
  };
}
