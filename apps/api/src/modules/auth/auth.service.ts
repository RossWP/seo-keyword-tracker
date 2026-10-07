import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';
import { hashPassword, verifyPassword } from '../../lib/passwords.js';
import { findUserByEmail } from '../users/users.repository.js';
import {
  deleteExpiredSessions,
  deleteSession,
  findActiveSession,
  insertSession,
  updateSessionExpiry,
} from './sessions.repository.js';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionUser {
  id: string;
  email: string;
  timezone: string;
}

export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

// Hashed once and reused, so a login for an unknown email takes as long as a wrong password.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword('not-a-real-password'));

/** The cookie carries the raw token; the database only ever sees its SHA-256. */
const sessionId = (token: string) => createHash('sha256').update(token).digest('hex');

export function createAuthService({ db, now }: { db: Database; now: () => Date }) {
  const expiresFrom = (time: Date) => new Date(time.getTime() + SESSION_TTL_MS);

  return {
    async login(
      email: string,
      password: string,
    ): Promise<{ user: SessionUser; session: IssuedSession }> {
      const user = await findUserByEmail(db, email);
      const valid = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), password);
      if (!user || !valid) {
        throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect');
      }

      const token = randomBytes(32).toString('base64url');
      const expiresAt = expiresFrom(now());
      await insertSession(db, { id: sessionId(token), userId: user.id, expiresAt });
      return {
        user: { id: user.id, email: user.email, timezone: user.timezone },
        session: { token, expiresAt },
      };
    },

    /**
     * Resolves a cookie token to its user. Sliding expiry: once less than half the TTL is left,
     * the session is extended and the new expiry returned so the cookie can be refreshed too.
     */
    async authenticate(
      token: string,
    ): Promise<{ user: SessionUser; renewedUntil?: Date } | undefined> {
      const id = sessionId(token);
      const current = now();
      const session = await findActiveSession(db, id, current);
      if (!session) return undefined;

      if (session.expiresAt.getTime() - current.getTime() > SESSION_TTL_MS / 2) {
        return { user: session.user };
      }
      const renewedUntil = expiresFrom(current);
      await updateSessionExpiry(db, id, renewedUntil);
      return { user: session.user, renewedUntil };
    },

    async logout(token: string): Promise<void> {
      await deleteSession(db, sessionId(token));
    },

    deleteExpiredSessions(): Promise<number> {
      return deleteExpiredSessions(db, now());
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
