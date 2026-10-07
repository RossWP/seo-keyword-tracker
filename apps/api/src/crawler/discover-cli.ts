import { BOT_TOKEN, BOT_USER_AGENT } from './bot.js';
import { discoverBlog } from './discovery.js';
import { CrawlError } from './errors.js';
import { createFetcher } from './fetcher.js';

// Usage: pnpm --filter @tracker/api discover https://example.com
const [siteUrl] = process.argv.slice(2);
if (!siteUrl) {
  console.error('Usage: pnpm --filter @tracker/api discover <website url>');
  process.exit(1);
}

const started = performance.now();
try {
  const result = await discoverBlog(siteUrl, {
    fetcher: createFetcher({ userAgent: BOT_USER_AGENT }),
    robotsAgent: BOT_TOKEN,
  });
  console.log(`Site:        ${result.origin}`);
  console.log(`Blog hub:    ${result.hubUrl ?? '(not linked from the homepage)'}`);
  console.log(`Sitemaps:    ${result.sitemapUrls.join(', ')}`);
  console.log(`Crawl-delay: ${result.crawlDelaySeconds ?? 'none'}`);
  console.log(`Posts (${result.entries.length}):`);
  for (const [index, entry] of result.entries.entries()) {
    console.log(
      `  ${String(index + 1).padStart(2)}. ${entry.url}${entry.allowedByRobots ? '' : '  [robots.txt: disallowed]'}`,
    );
  }
} catch (error) {
  if (!(error instanceof CrawlError)) throw error;
  console.error(`Discovery failed (${error.code}): ${error.message}`);
  process.exitCode = 1;
} finally {
  console.log(`Took ${Math.round(performance.now() - started)} ms`);
}
