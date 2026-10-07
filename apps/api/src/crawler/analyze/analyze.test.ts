import { describe, expect, it } from 'vitest';
import { extractPage } from './extract.js';
import { buildSiteContext, fetchFailureIssue, findIssues } from './issues.js';
import { extractKeywords, phrases } from './keywords.js';

const article = ({
  title,
  h1,
  description,
  body,
  head = '',
}: {
  title: string;
  h1: string;
  description?: string;
  body: string;
  head?: string;
}) => `<!doctype html><html lang="en"><head>
  <title>${title}</title>
  ${description ? `<meta name="description" content="${description}">` : ''}
  ${head}
</head><body>
  <header><nav><a href="/">Acme</a> <a href="/blog/">Acme blog</a> Pricing Login</nav></header>
  <main><article><h1>${h1}</h1>${body}</article></main>
  <footer>© Acme Inc. Acme newsletter. Acme careers.</footer>
</body></html>`;

const paragraph = (text: string, times: number) => `<p>${Array(times).fill(text).join(' ')}</p>`;

const keywordPage = extractPage(
  article({
    title: 'How to Do Keyword Research for SEO | Acme',
    h1: 'How to Do Keyword Research',
    description: 'A step-by-step keyword research process with free keyword tools.',
    body:
      '<h2>Why keyword research matters</h2>' +
      paragraph(
        'Keyword research shows what your audience searches for. Acme makes it simple.',
        6,
      ) +
      '<h2>Free keyword tools</h2>' +
      paragraph('Search volume and keyword difficulty decide which terms to target.', 4),
  }),
  'https://acme.example/blog/keyword-research/',
);
const linkPage = extractPage(
  article({
    title: 'Link Building Strategies That Work | Acme',
    h1: 'Link Building Strategies',
    body: paragraph(
      'Link building earns backlinks from relevant sites. Acme tracks every backlink.',
      8,
    ),
  }),
  'https://acme.example/blog/link-building-strategies/',
);
const auditPage = extractPage(
  article({
    title: 'Site Audit Checklist | Acme',
    h1: 'Site Audit Checklist',
    body: paragraph('A site audit finds crawl errors and broken links. Acme runs the audit.', 8),
  }),
  'https://acme.example/blog/site-audit-checklist/',
);

describe('extractPage', () => {
  it('reads head tags, headings and main content without page chrome', () => {
    expect(keywordPage.title).toBe('How to Do Keyword Research for SEO | Acme');
    expect(keywordPage.h1s).toEqual(['How to Do Keyword Research']);
    expect(keywordPage.headings).toEqual(['Why keyword research matters', 'Free keyword tools']);
    expect(keywordPage.lang).toBe('en');
    expect(keywordPage.mainText).not.toContain('Pricing');
    expect(keywordPage.mainText).not.toContain('careers');
    expect(keywordPage.wordCount).toBeGreaterThan(100);
  });

  it('reads JSON-LD types and keywords, including @graph', () => {
    const page = extractPage(
      `<html><head><script type="application/ld+json">{"@graph":[{"@type":"BlogPosting","keywords":"seo audit, crawl budget"},{"@type":"Organization"}]}</script><script type="application/ld+json">{broken</script></head><body></body></html>`,
      'https://a.example/x/',
    );
    expect(page.jsonLdTypes).toEqual(['BlogPosting', 'Organization']);
    expect(page.jsonLdKeywords).toEqual(['seo audit', 'crawl budget']);
  });
});

describe('phrases', () => {
  it('builds 1–4 word phrases that do not start or end with stopwords or cross punctuation', () => {
    const result = phrases('How to rank: the keyword research guide.');
    expect(result).toContain('keyword research');
    expect(result).toContain('rank');
    expect(result).not.toContain('how to rank');
    expect(result).not.toContain('rank the keyword');
  });
});

describe('extractKeywords', () => {
  const [keywordPicks = [], linkPicks = []] = extractKeywords([keywordPage, linkPage, auditPage]);

  it('ranks the topic phrase first and explains where it was found', () => {
    expect(keywordPicks[0]).toMatchObject({
      term: 'keyword research',
      sources: expect.arrayContaining([
        'title',
        'h1',
        'slug',
        'heading',
        'meta',
        'body',
      ]) as unknown,
    });
    expect(linkPicks[0]?.term).toBe('link building');
  });

  it('suppresses the brand name that appears on every page', () => {
    const terms = [...keywordPicks, ...linkPicks].map((pick) => pick.term);
    expect(terms.some((term) => term.includes('acme'))).toBe(false);
  });

  it('keeps at most 8 keywords without overlapping phrases', () => {
    expect(keywordPicks.length).toBeLessThanOrEqual(8);
    const terms = keywordPicks.map((pick) => pick.term);
    for (const term of terms) {
      const others = terms.filter((other) => other !== term);
      expect(others.some((other) => ` ${other} `.includes(` ${term} `))).toBe(false);
    }
  });
});

describe('findIssues', () => {
  const codes = (html: string, url = 'https://a.example/post/', xRobots: string | null = null) => {
    const page = extractPage(html, url, xRobots);
    return findIssues(page, buildSiteContext([page])).map((found) => found.code);
  };

  it('finds nothing wrong with a well-formed article', () => {
    const html = article({
      title: 'A well sized title for this article here',
      h1: 'One heading',
      description: 'Has a description.',
      head: '<link rel="canonical" href="https://a.example/post/">',
      body: paragraph('Plenty of genuinely useful words about the topic at hand.', 40),
    });
    expect(codes(html)).toEqual([]);
  });

  it('flags missing title, H1, description and canonical on a bare page', () => {
    expect(codes('<html><body><p>Hello</p></body></html>')).toEqual(
      expect.arrayContaining([
        'title_missing',
        'h1_missing',
        'meta_description_missing',
        'canonical_missing',
      ]),
    );
  });

  it('flags noindex from meta robots and from the X-Robots-Tag header', () => {
    expect(
      codes('<html><head><meta name="robots" content="noindex,follow"></head></html>'),
    ).toContain('noindex');
    expect(codes('<html></html>', 'https://a.example/x/', 'noindex')).toContain('noindex');
  });

  it('flags title length, multiple H1s, canonical elsewhere, thin content and image alts', () => {
    const html = `<html><head><title>Short</title><link rel="canonical" href="/other/"></head><body>
      <h1>One</h1><h1>Two</h1><img src="/a.png"><img src="/b.png" alt="">
      ${paragraph('Some words here.', 25)}</body></html>`;
    expect(codes(html)).toEqual(
      expect.arrayContaining([
        'title_length',
        'h1_multiple',
        'canonical_mismatch',
        'thin_content',
        'images_missing_alt',
      ]),
    );
  });

  it('flags pages rendered by JavaScript and insecure resources', () => {
    const html =
      '<html><body><div id="root"></div><script src="/app.js"></script><img src="http://cdn.example/x.png" alt="x"></body></html>';
    expect(codes(html)).toEqual(expect.arrayContaining(['client_rendered', 'mixed_content']));
  });

  it('flags titles shared by several pages of the same site', () => {
    const one = extractPage(
      '<title>Same title for two different posts</title>',
      'https://a.example/1/',
    );
    const two = extractPage(
      '<title>Same title for two different posts</title>',
      'https://a.example/2/',
    );
    const site = buildSiteContext([one, two]);
    expect(findIssues(one, site).map((found) => found.code)).toContain('title_duplicate');
  });

  it('describes a page that could not be fetched', () => {
    expect(fetchFailureIssue(404, 'Not Found')).toMatchObject({
      code: 'http_error',
      severity: 'error',
      details: { status: 404 },
    });
  });
});
