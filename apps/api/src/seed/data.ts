// Seed input data, not logic: the crawler never sees these names.
export const DEMO_USERS = [
  {
    email: 'alice@agency.test',
    client: { name: 'Semrush', websiteUrl: 'https://www.semrush.com' },
  },
  { email: 'bob@agency.test', client: { name: 'Yoast', websiteUrl: 'https://yoast.com' } },
] as const;

export const DEFAULT_DEMO_PASSWORD = 'demo-password';
