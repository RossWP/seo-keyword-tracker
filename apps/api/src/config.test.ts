import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('uses local defaults when nothing is set', () => {
    expect(loadConfig({})).toEqual({
      env: 'development',
      host: '0.0.0.0',
      port: 3000,
      logLevel: 'info',
      databaseUrl: 'postgres://tracker:tracker@localhost:5433/tracker',
    });
  });

  it('builds the database URL from POSTGRES_* and encodes credentials', () => {
    const config = loadConfig({
      POSTGRES_USER: 'seo',
      POSTGRES_PASSWORD: 'p@ss:w/rd',
      POSTGRES_DB: 'seo_db',
      POSTGRES_PORT: '6543',
    });
    expect(config.databaseUrl).toBe('postgres://seo:p%40ss%3Aw%2Frd@localhost:6543/seo_db');
  });

  it('prefers DATABASE_URL over POSTGRES_*', () => {
    const config = loadConfig({
      POSTGRES_PORT: '6543',
      DATABASE_URL: 'postgres://tracker:tracker@db:5432/tracker',
    });
    expect(config.databaseUrl).toBe('postgres://tracker:tracker@db:5432/tracker');
  });

  it('rejects invalid values with the variable name in the message', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ DATABASE_URL: 'mysql://localhost/db' })).toThrow(/DATABASE_URL/);
  });
});
