import type { FastifyServerOptions } from 'fastify';
import { buildApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { createDb } from './db/client.js';
import { createPool } from './lib/db.js';
import { createServices } from './services.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const services = createServices({ db: createDb(pool), now: () => new Date() });

const app = buildApp({
  logger: loggerOptions(config),
  checkDatabase: async () => {
    await pool.query('select 1');
  },
  services,
  cookies: { secure: config.cookieSecure },
});

// An idle client losing its connection must not crash the process.
pool.on('error', (error) => {
  app.log.error({ err: error }, 'idle database client error');
});
app.addHook('onClose', async () => {
  clearInterval(sessionCleanup);
  await pool.end();
});

const sessionCleanup = setInterval(() => void cleanupSessions(), SESSION_CLEANUP_INTERVAL_MS);
sessionCleanup.unref();

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

await app.listen({ host: config.host, port: config.port });
void cleanupSessions();

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
