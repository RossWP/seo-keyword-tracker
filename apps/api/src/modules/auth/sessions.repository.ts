import { and, eq, gt, lte } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { sessions, users } from '../../db/schema.js';

export async function insertSession(
  db: Database,
  session: { id: string; userId: string; expiresAt: Date },
): Promise<void> {
  await db.insert(sessions).values(session);
}

export async function findActiveSession(db: Database, id: string, now: Date) {
  const [row] = await db
    .select({
      expiresAt: sessions.expiresAt,
      user: { id: users.id, email: users.email, timezone: users.timezone },
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, now)));
  return row;
}

export async function updateSessionExpiry(
  db: Database,
  id: string,
  expiresAt: Date,
): Promise<void> {
  await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, id));
}

export async function deleteSession(db: Database, id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id));
}

export async function deleteExpiredSessions(db: Database, now: Date): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(lte(sessions.expiresAt, now))
    .returning({ id: sessions.id });
  return deleted.length;
}
