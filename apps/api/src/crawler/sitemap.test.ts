import { describe, expect, it } from 'vitest';
import { readSitemap } from './sitemap.js';

async function* chunksOf(text: string, size = 7) {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += size) yield bytes.slice(i, i + size);
}

const urlset = (locs: string[], extra = '') =>
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${locs.map((loc) => `<url><loc>${loc}</loc>${extra}</url>`).join('\n')}
</urlset>`;

describe('readSitemap', () => {
  it('reads a urlset in order, ignoring image locations', async () => {
    const xml = urlset(
      ['https://a.com/one/', 'https://a.com/two/'],
      '<image:image><image:loc>https://a.com/img.png</image:loc></image:image>',
    );
    expect(await readSitemap(chunksOf(xml), 100)).toEqual({
      kind: 'urlset',
      urls: ['https://a.com/one/', 'https://a.com/two/'],
      complete: true,
    });
  });

  it('reads a sitemap index', async () => {
    const xml = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://a.com/post-sitemap.xml</loc><lastmod>2026-10-01</lastmod></sitemap>
      <sitemap><loc> https://a.com/page-sitemap.xml </loc></sitemap>
    </sitemapindex>`;
    const result = await readSitemap(chunksOf(xml), 100);
    expect(result.kind).toBe('index');
    expect(result.urls).toEqual([
      'https://a.com/post-sitemap.xml',
      'https://a.com/page-sitemap.xml',
    ]);
  });

  it('stops after maxUrls', async () => {
    const xml = urlset(Array.from({ length: 50 }, (_, i) => `https://a.com/p${i}/`));
    const result = await readSitemap(chunksOf(xml), 15);
    expect(result.urls).toHaveLength(15);
    expect(result.complete).toBe(false);
  });

  it('decodes entities, CDATA and a byte-order mark', async () => {
    const xml = `\uFEFF<urlset><url><loc>https://a.com/?a=1&amp;b=2</loc></url><url><loc><![CDATA[https://a.com/c/]]></loc></url></urlset>`;
    expect((await readSitemap(chunksOf(xml), 10)).urls).toEqual([
      'https://a.com/?a=1&b=2',
      'https://a.com/c/',
    ]);
  });

  it('keeps what it read before malformed XML', async () => {
    const xml = '<urlset><url><loc>https://a.com/ok/</loc></url><url><loc>broken</url';
    const result = await readSitemap(chunksOf(xml), 10);
    expect(result.urls).toEqual(['https://a.com/ok/']);
  });

  it('reads plain-text sitemaps', async () => {
    const text = 'https://a.com/one/\n\nhttps://a.com/two/\nnot a url\n';
    expect(await readSitemap(chunksOf(text), 10)).toEqual({
      kind: 'text',
      urls: ['https://a.com/one/', 'https://a.com/two/'],
      complete: true,
    });
  });

  it('marks HTML and feeds as unknown', async () => {
    expect(
      (await readSitemap(chunksOf('<!doctype html><html><body>Hi</body></html>'), 10)).kind,
    ).toBe('unknown');
  });
});
