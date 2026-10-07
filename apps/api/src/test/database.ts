import { loadConfig } from '../config.js';

// Tests run against a separate database on the same server, so dev data is never touched.
export function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const url = new URL(loadConfig().databaseUrl);
  url.pathname = `${url.pathname}_test`;
  return url.toString();
}
