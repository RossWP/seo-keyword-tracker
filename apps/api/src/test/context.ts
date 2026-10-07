import { sql } from 'drizzle-orm';
import pg from 'pg';
import { buildApp } from '../app.js';
import { createDb, type Database } from '../db/client.js';
import { createServices } from '../services.js';
import { testDatabaseUrl } from './database.js';

type App = ReturnType<typeof buildApp>;

export interface TestContext {
  /** Rebuilt on every `reset()`, so in-memory state like rate limits never leaks between tests. */
  readonly app: App;
  db: Database;
  clock: { now: Date };
  /** Client ids the app asked to crawl (the crawl itself is tested separately). */
  enqueued: string[];
  reset(): Promise<void>;
  close(): Promise<void>;
}

const START = new Date('2026-10-07T12:00:00Z');

/**
 * A real app on the test database with a controllable clock. One per test file:
 * call `reset()` in beforeEach and `close()` in afterAll.
 */
export function createTestContext(
  options: { checkDatabase?: () => Promise<void> } = {},
): TestContext {
  const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 4 });
  const db = createDb(pool);
  const clock = { now: START };
  const enqueued: string[] = [];
  const services = createServices({ db, now: () => clock.now });
  const build = () =>
    buildApp({
      logger: false,
      checkDatabase: options.checkDatabase ?? (() => Promise.resolve()),
      services,
      db,
      enqueueCrawl: (clientId: string) => enqueued.push(clientId),
      cookies: { secure: false },
    });
  let app = build();

  return {
    get app() {
      return app;
    },
    db,
    clock,
    enqueued,
    async reset() {
      await app.close();
      app = build();
      clock.now = START;
      enqueued.length = 0;
      await db.execute(sql`truncate users, keywords restart identity cascade`);
    },
    async close() {
      await app.close();
      await pool.end();
    },
  };
}
