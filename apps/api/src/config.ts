import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65535);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: port.default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  POSTGRES_USER: z.string().min(1).default('tracker'),
  POSTGRES_PASSWORD: z.string().min(1).default('tracker'),
  POSTGRES_DB: z.string().min(1).default('tracker'),
  POSTGRES_PORT: port.default(5433),
  // Overrides the URL built from POSTGRES_* (Docker network, tests, hosted databases).
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  // Defaults to true in production; false locally because dev runs over plain http.
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  // Addresses of reverse proxies in front of the API, as IPs, CIDRs or the names loopback,
  // linklocal, uniquelocal (nginx in Docker: uniquelocal). Their X-Forwarded-For gives the client
  // IP used by the login rate limit. Unset trusts no proxy, so the header can't be spoofed.
  TRUST_PROXY: z.string().trim().min(1).optional(),
});

type Env = z.infer<typeof envSchema>;

export interface Config {
  env: Env['NODE_ENV'];
  host: string;
  port: number;
  logLevel: Env['LOG_LEVEL'];
  databaseUrl: string;
  cookieSecure: boolean;
  trustProxy: string | undefined;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;
  return {
    env: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL ?? localDatabaseUrl(env),
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
    trustProxy: env.TRUST_PROXY,
  };
}

function localDatabaseUrl(env: Env): string {
  const user = encodeURIComponent(env.POSTGRES_USER);
  const password = encodeURIComponent(env.POSTGRES_PASSWORD);
  return `postgres://${user}:${password}@localhost:${env.POSTGRES_PORT}/${env.POSTGRES_DB}`;
}
