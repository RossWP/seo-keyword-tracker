import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer } from '../test/fixture-server.js';
import { CrawlError } from './errors.js';
import { createFetcher, decodeBody } from './fetcher.js';

let failuresLeft = 1;
const server = await startFixtureServer({
  '/ok': { body: '<h1>ok</h1>' },
  '/redirect': { status: 301, body: '', headers: { location: '/ok' } },
  '/loop': { status: 302, body: '', headers: { location: '/loop' } },
  '/big': { body: 'x'.repeat(2_000) },
  '/sitemap.xml.gz': { type: 'application/x-gzip', body: gzipSync('<urlset></urlset>') },
  '/flaky': (_request, response) => {
    if (failuresLeft-- > 0) response.writeHead(503, { 'retry-after': '0' }).end();
    else response.writeHead(200, { 'content-type': 'text/plain' }).end('recovered');
  },
  '/slow': (_request, response) => {
    setTimeout(() => response.writeHead(200).end('late'), 1_000);
  },
  '/latin1': {
    type: 'text/html; charset=windows-1252',
    body: Buffer.from([0x63, 0x61, 0x66, 0xe9]),
  },
});
afterAll(() => server.close());

const fetcher = createFetcher({
  userAgent: 'test-bot',
  timeoutMs: 300,
  attempts: 2,
  allowPrivateNetworks: true,
});
const options = { accept: '*/*', maxBytes: 1_000 };

async function crawlErrorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CrawlError) return error.code;
    throw error;
  }
  return undefined;
}

describe('fetcher', () => {
  it('follows redirects and reports the final URL', async () => {
    const page = await fetcher.fetch(`${server.origin}/redirect`, options);
    expect(page.status).toBe(200);
    expect(page.url).toBe(`${server.origin}/ok`);
    expect(decodeBody(page.body, page.contentType)).toBe('<h1>ok</h1>');
  });

  it('stops redirect loops', async () => {
    expect(await crawlErrorCode(fetcher.fetch(`${server.origin}/loop`, options))).toBe(
      'too_many_redirects',
    );
  });

  it('refuses bodies over the size limit', async () => {
    expect(await crawlErrorCode(fetcher.fetch(`${server.origin}/big`, options))).toBe('too_large');
  });

  it('gunzips .gz files', async () => {
    const page = await fetcher.fetch(`${server.origin}/sitemap.xml.gz`, options);
    expect(decodeBody(page.body, '')).toBe('<urlset></urlset>');
  });

  it('retries a 503 and returns the recovered answer', async () => {
    const page = await fetcher.fetch(`${server.origin}/flaky`, options);
    expect(decodeBody(page.body, page.contentType)).toBe('recovered');
  });

  it('times out slow servers', async () => {
    expect(await crawlErrorCode(fetcher.fetch(`${server.origin}/slow`, options))).toBe('timeout');
  });

  it('decodes the charset from Content-Type', async () => {
    const page = await fetcher.fetch(`${server.origin}/latin1`, options);
    expect(decodeBody(page.body, page.contentType)).toBe('café');
  });
});

describe('fetcher network guard', () => {
  const guarded = createFetcher({ userAgent: 'test-bot', timeoutMs: 1_000, attempts: 1 });
  let localUrl: string;

  beforeAll(() => {
    localUrl = `${server.origin}/ok`;
  });

  it.each([
    ['loopback IP', 'http://127.0.0.1/ok'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['private range', 'http://10.0.0.5/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['IPv4-mapped IPv6', 'http://[::ffff:192.168.1.1]/'],
  ])('blocks %s', async (_name, url) => {
    expect(await crawlErrorCode(guarded.fetch(url, options))).toBe('blocked_host');
  });

  it('blocks hostnames that resolve to private addresses', async () => {
    expect(await crawlErrorCode(guarded.fetch('http://localhost/ok', options))).toBe(
      'blocked_host',
    );
  });

  it('blocks non-standard ports and credentials', async () => {
    expect(await crawlErrorCode(guarded.fetch(localUrl, options))).toBe('blocked_host');
    expect(await crawlErrorCode(guarded.fetch('https://user:pass@example.com/', options))).toBe(
      'invalid_url',
    );
  });

  it('rejects non-http schemes', async () => {
    expect(await crawlErrorCode(guarded.fetch('file:///etc/passwd', options))).toBe('invalid_url');
  });
});
