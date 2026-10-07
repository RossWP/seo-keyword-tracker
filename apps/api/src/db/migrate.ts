import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './client.js';

// Migrations live next to the package, so the path works from src/ (tsx) and dist/ (node).
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder });
}
