import type { FastifyServerOptions } from 'fastify';
import { buildApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { BOT_USER_AGENT } from './crawler/bot.js';
import { crawlClient } from './crawler/crawl-job.js';
import { createCrawlRunner } from './crawler/crawl-runner.js';
import { requeueStaleCrawls } from './crawler/crawl.repository.js';
import { createFetcher } from './crawler/fetcher.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createPool } from './lib/db.js';
import { createServices } from './services.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const CRAWL_RESUME_INTERVAL_MS = 60 * 1000;
/** A crawl whose heartbeat is older than this was left behind by a stopped process. */
const STALE_CRAWL_MS = 2 * 60 * 1000;

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const db = createDb(pool);
const now = () => new Date();
const services = createServices({ db, now });

const app = buildApp({
  logger: loggerOptions(config),
  checkDatabase: async () => {
    await pool.query('select 1');
  },
  services,
  db,
  // The runner is created just below (it logs through the app); this is only called per request.
  enqueueCrawl: (clientId) => {
    crawler.enqueue(clientId);
  },
  cookies: { secure: config.cookieSecure },
  trustProxy: config.trustProxy,
});

const fetcher = createFetcher({ userAgent: BOT_USER_AGENT });
const crawler = createCrawlRunner({
  run: (clientId, signal) => crawlClient(clientId, { db, now, log: app.log, fetcher }, signal),
  log: app.log,
});

// An idle client losing its connection must not crash the process.
pool.on('error', (error) => {
  app.log.error({ err: error }, 'idle database client error');
});
app.addHook('onClose', async () => {
  clearInterval(sessionCleanup);
  clearInterval(crawlResume);
  await crawler.drain();
  await pool.end();
});

const sessionCleanup = setInterval(() => void cleanupSessions(), SESSION_CLEANUP_INTERVAL_MS);
sessionCleanup.unref();
// Also catches crawls orphaned by a crashed process once their heartbeat goes stale.
const crawlResume = setInterval(() => void resumeCrawls(), CRAWL_RESUME_INTERVAL_MS);
crawlResume.unref();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    setTimeout(() => {
      app.log.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
  });
}

// Schema first: a fresh database (docker compose up, a clean clone) works without a manual step.
await runMigrations(db);
await app.listen({ host: config.host, port: config.port });
void cleanupSessions();
void resumeCrawls();

async function resumeCrawls(): Promise<void> {
  try {
    const clientIds = await requeueStaleCrawls(db, new Date(Date.now() - STALE_CRAWL_MS));
    if (clientIds.length > 0) app.log.info({ clientIds }, 'resuming unfinished crawls');
    for (const clientId of clientIds) crawler.enqueue(clientId);
  } catch (error) {
    app.log.warn({ err: error }, 'could not resume unfinished crawls');
  }
}

async function cleanupSessions(): Promise<void> {
  try {
    const deleted = await services.auth.deleteExpiredSessions();
    if (deleted > 0) app.log.info({ deleted }, 'expired sessions removed');
  } catch (error) {
    app.log.warn({ err: error }, 'expired session cleanup failed');
  }
}

function loggerOptions({ env, logLevel }: Config): FastifyServerOptions['logger'] {
  if (env === 'development') {
    return { level: logLevel, transport: { target: 'pino-pretty' } };
  }
  return { level: logLevel };
}
