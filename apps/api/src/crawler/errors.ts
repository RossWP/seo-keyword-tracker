export type CrawlErrorCode =
  | 'invalid_url'
  | 'blocked_host'
  | 'site_unreachable'
  | 'timeout'
  | 'too_large'
  | 'too_many_redirects'
  | 'no_sitemap'
  | 'no_blog_found'
  | 'blocked_by_site';

/** An expected crawl failure with a code the UI can explain; never a bug. */
export class CrawlError extends Error {
  constructor(
    readonly code: CrawlErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'CrawlError';
  }
}
