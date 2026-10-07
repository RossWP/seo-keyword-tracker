import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema> & { $client: pg.Pool };

export function createDb(pool: pg.Pool): Database {
  return drizzle({ client: pool, schema });
}
