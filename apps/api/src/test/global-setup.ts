import pg from 'pg';
import { createDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { testDatabaseUrl } from './database.js';

// Recreates the test database once per run and applies all migrations to it.
export default async function setup(): Promise<void> {
  const url = new URL(testDatabaseUrl());
  const name = url.pathname.slice(1);
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';

  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  try {
    await admin.connect();
  } catch (error) {
    throw new Error(
      `Tests need Postgres at ${url.host}. Start it with: docker compose up -d --wait db`,
      { cause: error },
    );
  }
  try {
    const quoted = pg.escapeIdentifier(name);
    await admin.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${quoted}`);
  } finally {
    await admin.end();
  }

  const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
  try {
    await runMigrations(createDb(pool));
  } finally {
    await pool.end();
  }
}
