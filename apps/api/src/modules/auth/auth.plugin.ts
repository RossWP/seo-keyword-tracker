import type { FastifyInstance, FastifyReply } from 'fastify';
import { AppError } from '../../lib/errors.js';
import type { AuthService, SessionUser } from './auth.service.js';

export const SESSION_COOKIE = 'sid';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export interface CookieSettings {
  secure: boolean;
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  expires: Date,
  { secure }: CookieSettings,
): void {
  void reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    expires,
  });
}

export function clearSessionCookie(reply: FastifyReply, { secure }: CookieSettings): void {
  void reply.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure, path: '/' });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Loads the signed-in user from the session cookie for every request, and rejects
 * state-changing requests sent from another origin (CSRF defence on top of SameSite=Lax).
 */
export function registerSessionHooks(
  app: FastifyInstance,
  auth: AuthService,
  cookies: CookieSettings,
): void {
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (request) => {
    if (SAFE_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    if (origin !== undefined && originHost(origin) !== request.host) {
      throw new AppError(403, 'forbidden_origin', 'Cross-origin request rejected');
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    const result = await auth.authenticate(token);
    if (!result) {
      clearSessionCookie(reply, cookies);
      return;
    }
    request.user = result.user;
    if (result.renewedUntil) setSessionCookie(reply, token, result.renewedUntil, cookies);
  });
}

/** Host of an Origin header; undefined for "null" and malformed values, which never match. */
function originHost(origin: string): string | undefined {
  try {
    return new URL(origin).host;
  } catch {
    return undefined;
  }
}

/** Use as an onRequest hook on every route that needs a signed-in user. */
export async function requireUser(request: { user: SessionUser | null }): Promise<void> {
  if (!request.user) throw new AppError(401, 'unauthorized', 'Sign in to continue');
}

/** For handlers behind `requireUser`: the user is guaranteed, this narrows the type. */
export function currentUser(request: { user: SessionUser | null }): SessionUser {
  if (!request.user) throw new AppError(401, 'unauthorized', 'Sign in to continue');
  return request.user;
}
