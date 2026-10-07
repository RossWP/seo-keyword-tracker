import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { users } from '../../db/schema.js';

export type UserRow = typeof users.$inferSelect;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(db: Database, email: string): Promise<UserRow | undefined> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)));
  return user;
}

/** Creates the user or, if the email exists, updates its password. Returns the user either way. */
export async function upsertUser(
  db: Database,
  values: { email: string; passwordHash: string; timezone?: string },
): Promise<UserRow> {
  const email = normalizeEmail(values.email);
  const [user] = await db
    .insert(users)
    .values({ ...values, email })
    .onConflictDoUpdate({ target: users.email, set: { passwordHash: values.passwordHash } })
    .returning();
  if (!user) throw new Error(`Failed to upsert user ${email}`);
  return user;
}
