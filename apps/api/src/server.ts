import type { FastifyServerOptions } from 'fastify';
import { buildApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { createPool } from './lib/db.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const config = loadConfig();
const pool = createPool(config.databaseUrl);

const app = buildApp({
  logger: loggerOptions(config),
  checkDatabase: async () => {
    await pool.query('select 1');
  },
});

// An idle client losing its connection must not crash the process.
pool.on('error', (error) => {
  app.log.error({ err: error }, 'idle database client error');
});
app.addHook('onClose', async () => {
  await pool.end();
});

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

function loggerOptions({ env, logLevel }: Config): FastifyServerOptions['logger'] {
  if (env === 'development') {
    return { level: logLevel, transport: { target: 'pino-pretty' } };
  }
  return { level: logLevel };
}
