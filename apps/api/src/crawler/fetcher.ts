import { setTimeout as sleep } from 'node:timers/promises';
import { Agent, fetch, type Response } from 'undici';
import { CrawlError } from './errors.js';
import { assertPublicLiteral, publicOnlyLookup } from './ssrf.js';

export interface FetcherOptions {
  userAgent: string;
  /** Per attempt, covering connect, headers and body. */
  timeoutMs?: number;
  maxRedirects?: number;
  /** Attempts for network errors, timeouts, 429 and 5xx. 4xx answers are never retried. */
  attempts?: number;
  /** Only for tests against a local fixture server. */
  allowPrivateNetworks?: boolean;
}

export interface FetchedPage {
  /** URL after redirects. */
  url: string;
  status: number;
  headers: Headers;
  contentType: string;
  body: Uint8Array;
  elapsedMs: number;
}

export interface OpenedResponse {
  url: string;
  status: number;
  headers: Headers;
  contentType: string;
  /** Decompressed body chunks, capped at `maxBytes`; stop iterating to cancel the download. */
  chunks: AsyncIterable<Uint8Array>;
}

export interface RequestOptions {
  accept: string;
  maxBytes: number;
  /** Overrides the fetcher's per-attempt timeout, e.g. for large, slowly generated sitemaps. */
  timeoutMs?: number;
}

export interface Fetcher {
  fetch(url: string, options: RequestOptions): Promise<FetchedPage>;
  open(url: string, options: RequestOptions): Promise<OpenedResponse>;
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 30_000;

export function createFetcher({
  userAgent,
  timeoutMs = 15_000,
  maxRedirects = 5,
  attempts = 3,
  allowPrivateNetworks = false,
}: FetcherOptions): Fetcher {
  // Deadlines come from the per-attempt AbortSignal below, so one request can be given longer.
  const dispatcher = new Agent({
    connect: allowPrivateNetworks ? {} : { lookup: publicOnlyLookup },
  });

  /** One attempt: follows redirects by hand so every hop is validated. */
  async function request(
    startUrl: string,
    accept: string,
    signal: AbortSignal,
  ): Promise<{ url: string; response: Response }> {
    let url = startUrl;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const target = validateTarget(url, allowPrivateNetworks);
      let response: Response;
      try {
        response = await fetch(target, {
          dispatcher,
          redirect: 'manual',
          signal,
          headers: { 'user-agent': userAgent, accept, 'accept-language': 'en' },
        });
      } catch (error) {
        throw toCrawlError(error, url, signal);
      }
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        url = new URL(location, target).toString();
        continue;
      }
      return { url, response };
    }
    throw new CrawlError(
      'too_many_redirects',
      `More than ${maxRedirects} redirects from ${startUrl}`,
    );
  }

  async function open(
    url: string,
    { accept, maxBytes, timeoutMs: requestTimeoutMs }: RequestOptions,
  ): Promise<OpenedResponse> {
    for (let attempt = 1; ; attempt++) {
      const signal = AbortSignal.timeout(requestTimeoutMs ?? timeoutMs);
      try {
        const { url: finalUrl, response } = await request(url, accept, signal);
        if (RETRY_STATUSES.has(response.status) && attempt < attempts) {
          await response.body?.cancel();
          await sleep(retryDelay(attempt, response.headers.get('retry-after')));
          continue;
        }
        const contentType = response.headers.get('content-type') ?? '';
        return {
          url: finalUrl,
          status: response.status,
          headers: response.headers as unknown as Headers,
          contentType,
          chunks: readCapped(response, finalUrl, contentType, maxBytes),
        };
      } catch (error) {
        const retryable =
          error instanceof CrawlError &&
          (error.code === 'timeout' || error.code === 'site_unreachable');
        if (!retryable || attempt >= attempts) throw error;
        await sleep(retryDelay(attempt, null));
      }
    }
  }

  return {
    open,
    async fetch(url, options) {
      const started = performance.now();
      const opened = await open(url, options);
      const parts: Uint8Array[] = [];
      for await (const chunk of opened.chunks) parts.push(chunk);
      return {
        url: opened.url,
        status: opened.status,
        headers: opened.headers,
        contentType: opened.contentType,
        body: Buffer.concat(parts),
        elapsedMs: Math.round(performance.now() - started),
      };
    },
  };
}

function validateTarget(url: string, allowPrivateNetworks: boolean): URL {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new CrawlError('invalid_url', `Not a valid URL: ${url}`);
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new CrawlError('invalid_url', `Only http and https are supported: ${url}`);
  }
  if (target.username || target.password) {
    throw new CrawlError('invalid_url', `URLs with credentials are not fetched: ${url}`);
  }
  if (!allowPrivateNetworks) {
    if (target.port !== '' && target.port !== '80' && target.port !== '443') {
      throw new CrawlError('blocked_host', `Only ports 80 and 443 are fetched: ${url}`);
    }
    assertPublicLiteral(target.hostname);
  }
  return target;
}

/** Streams the body (gunzipping .gz files) and fails once it exceeds `maxBytes` decompressed. */
async function* readCapped(
  response: Response,
  url: string,
  contentType: string,
  maxBytes: number,
): AsyncGenerator<Uint8Array> {
  if (!response.body) return;
  // fetch already decodes Content-Encoding; this handles files that are themselves gzip (.xml.gz).
  const gzipped = /gzip/i.test(contentType) || new URL(url).pathname.endsWith('.gz');
  const stream: ReadableStream<Uint8Array> = gzipped
    ? response.body.pipeThrough(new DecompressionStream('gzip'))
    : response.body;
  const reader = stream.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new CrawlError('too_large', `${url} is larger than ${Math.round(maxBytes / 1e6)} MB`);
      }
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function retryDelay(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const base = 500 * 2 ** (attempt - 1);
  return base / 2 + Math.random() * base;
}

function toCrawlError(error: unknown, url: string, signal: AbortSignal): CrawlError {
  if (error instanceof CrawlError) return error;
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof CrawlError) return cause;
  if (signal.aborted)
    return new CrawlError('timeout', `Timed out fetching ${url}`, { cause: error });
  return new CrawlError('site_unreachable', `Could not reach ${url}`, { cause: error });
}

/**
 * Decodes a body using the charset from the Content-Type header, then a <meta charset> in the
 * first kilobyte (for HTML), falling back to UTF-8.
 */
export function decodeBody(body: Uint8Array, contentType: string): string {
  const head = new TextDecoder('latin1').decode(body.subarray(0, 1024));
  const charset =
    /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}
