import { describe, expect, it } from 'vitest';
import { isSameSite, normalizePageUrl, parseWebsiteUrl } from './url.js';

describe('parseWebsiteUrl', () => {
  it('normalises a website and derives its site key', () => {
    expect(parseWebsiteUrl('  https://WWW.Yoast.com/blog/?ref=x#top ')).toEqual({
      url: 'https://www.yoast.com/blog/',
      origin: 'https://www.yoast.com',
      siteKey: 'yoast.com',
    });
  });

  it('gives every spelling of one site the same key', () => {
    const keys = ['https://yoast.com', 'http://www.yoast.com/', 'https://YOAST.COM./'].map(
      (input) => parseWebsiteUrl(input)?.siteKey,
    );
    expect(new Set(keys)).toEqual(new Set(['yoast.com']));
  });

  it('punycodes internationalised domains', () => {
    expect(parseWebsiteUrl('https://bücher.de')?.siteKey).toBe('xn--bcher-kva.de');
  });

  it.each([
    'yoast.com',
    'ftp://yoast.com',
    'javascript:alert(1)',
    'https://localhost',
    'https://u:p@yoast.com',
    '',
  ])('rejects %j', (input) => {
    expect(parseWebsiteUrl(input)).toBeNull();
  });
});

describe('normalizePageUrl', () => {
  it('drops fragments and tracking parameters but keeps real ones', () => {
    expect(normalizePageUrl('https://a.com/post/?utm_source=x&page=2#comments')).toBe(
      'https://a.com/post/?page=2',
    );
  });

  it('resolves relative URLs and rejects other schemes', () => {
    expect(normalizePageUrl('/blog/', 'https://a.com/x')).toBe('https://a.com/blog/');
    expect(normalizePageUrl('mailto:hi@a.com')).toBeNull();
  });
});

describe('isSameSite', () => {
  it('ignores www', () => {
    expect(isSameSite('https://www.semrush.com/a', 'https://semrush.com/b')).toBe(true);
    expect(isSameSite('https://www.semrush.com/', 'https://de.semrush.com/')).toBe(false);
  });
});
