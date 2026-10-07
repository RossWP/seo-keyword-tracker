import { loadConfig } from '../config.js';
import { createPool } from '../lib/db.js';
import { createDb } from './client.js';
import { runMigrations } from './migrate.js';

const pool = createPool(loadConfig().databaseUrl);
try {
  await runMigrations(createDb(pool));
  console.log('Migrations applied');
} finally {
  await pool.end();
}
