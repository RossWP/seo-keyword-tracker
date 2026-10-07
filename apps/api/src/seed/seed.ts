import { z } from 'zod';
import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { createPool } from '../lib/db.js';
import { hashPassword } from '../lib/passwords.js';
import { upsertUser } from '../modules/users/users.repository.js';
import { DEFAULT_DEMO_PASSWORD, DEMO_USERS } from './data.js';

const seedEnv = z.object({
  SEED_PASSWORD: z.string().min(8).default(DEFAULT_DEMO_PASSWORD),
});

const { SEED_PASSWORD: password } = seedEnv.parse(process.env);
const pool = createPool(loadConfig().databaseUrl);
const db = createDb(pool);

try {
  await runMigrations(db);

  // Idempotent: re-running updates the password instead of duplicating users.
  const passwordHash = await hashPassword(password);
  for (const { email } of DEMO_USERS) {
    await upsertUser(db, { email, passwordHash });
  }

  console.log('Seed complete. Demo accounts:');
  for (const { email } of DEMO_USERS) console.log(`  ${email} / ${password}`);
} finally {
  await pool.end();
}
