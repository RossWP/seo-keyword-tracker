import { SaxesParser } from 'saxes';

export interface SitemapDocument {
  kind: 'index' | 'urlset' | 'text' | 'unknown';
  /** <loc> values in document order (child sitemaps for an index, pages for a urlset). */
  urls: string[];
  /** False when reading stopped at `maxUrls` (or the XML was malformed part-way). */
  complete: boolean;
}

/**
 * Reads a sitemap incrementally and stops after `maxUrls` locations, so a 50 MB sitemap
 * costs no more than its first few kilobytes. Lenient: malformed XML keeps what was read.
 * Handles XML sitemaps and sitemap indexes, and plain-text sitemaps (one URL per line).
 */
export async function readSitemap(
  chunks: AsyncIterable<Uint8Array>,
  maxUrls: number,
): Promise<SitemapDocument> {
  // TextDecoder also drops a leading byte-order mark.
  const decoder = new TextDecoder('utf-8');
  const urls: string[] = [];
  let root: SitemapDocument['kind'] | undefined;
  let failed = false;

  const parser = new SaxesParser();
  const stack: string[] = [];
  let loc: string | null = null;

  parser.on('opentag', (tag) => {
    const name = localName(tag.name);
    if (stack.length === 0) {
      root = name === 'sitemapindex' ? 'index' : name === 'urlset' ? 'urlset' : 'unknown';
    }
    stack.push(name);
    // Only an unprefixed <loc> directly inside <url>/<sitemap>: skips <image:loc>, <video:loc>.
    if (tag.name === 'loc' && isEntry(stack.at(-2))) loc = '';
  });
  const collect = (text: string) => {
    if (loc !== null) loc += text;
  };
  parser.on('text', collect);
  parser.on('cdata', collect);
  parser.on('closetag', () => {
    if (stack.pop() === 'loc' && loc !== null) {
      const value = loc.trim();
      if (value) urls.push(value);
      loc = null;
    }
  });
  parser.on('error', () => {
    failed = true;
  });

  // The first non-blank character decides the format: "<" is XML, anything else plain text.
  let mode: 'xml' | 'text' | undefined;
  let pending = '';
  for await (const chunk of chunks) {
    pending += decoder.decode(chunk, { stream: true });
    if (mode === undefined) {
      const head = pending.trimStart();
      if (head === '') continue;
      mode = head.startsWith('<') ? 'xml' : 'text';
    }
    if (mode === 'text') {
      if (textLines(pending).length >= maxUrls) break;
      continue;
    }
    try {
      parser.write(pending);
    } catch {
      failed = true;
    }
    pending = '';
    if (urls.length >= maxUrls || failed) break;
  }

  if (mode === 'text') {
    const lines = textLines(pending);
    return { kind: 'text', urls: lines.slice(0, maxUrls), complete: lines.length <= maxUrls };
  }
  return {
    kind: root ?? 'unknown',
    urls: urls.slice(0, maxUrls),
    complete: !failed && urls.length < maxUrls,
  };
}

function localName(name: string): string {
  const index = name.indexOf(':');
  return (index === -1 ? name : name.slice(index + 1)).toLowerCase();
}

const isEntry = (name: string | undefined) => name === 'url' || name === 'sitemap';

function textLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line));
}
