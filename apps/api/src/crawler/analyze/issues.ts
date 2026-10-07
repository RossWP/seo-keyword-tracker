import type { PageFacts } from './extract.js';

export type IssueSeverity = 'error' | 'warning';

export interface SeoIssue {
  code: string;
  severity: IssueSeverity;
  message: string;
  details?: Record<string, unknown>;
}

export interface SiteContext {
  /** How many crawled pages of the same client use each title. */
  titleCounts: Map<string, number>;
}

type Rule = (page: PageFacts, site: SiteContext) => SeoIssue | null;

const issue = (
  code: string,
  severity: IssueSeverity,
  message: string,
  details?: Record<string, unknown>,
): SeoIssue => (details ? { code, severity, message, details } : { code, severity, message });

const TITLE_RANGE = { min: 30, max: 60 };
const THIN_CONTENT_WORDS = 300;

/** Each rule is a pure function of the page (and its siblings), so each is testable alone. */
const RULES: Rule[] = [
  (page) =>
    /\bnoindex\b|\bnone\b/.test(page.robots)
      ? issue('noindex', 'error', 'Page asks search engines not to index it', {
          robots: page.robots,
        })
      : null,
  (page) => (page.title ? null : issue('title_missing', 'error', 'Page has no <title>')),
  (page) => {
    const length = page.title?.length ?? 0;
    if (!page.title || (length >= TITLE_RANGE.min && length <= TITLE_RANGE.max)) return null;
    return issue(
      'title_length',
      'warning',
      `Title is ${length} characters; ${TITLE_RANGE.min}–${TITLE_RANGE.max} usually displays best`,
      { length },
    );
  },
  (page, site) => {
    const count = page.title ? (site.titleCounts.get(page.title) ?? 0) : 0;
    return count > 1
      ? issue('title_duplicate', 'warning', `${count} crawled pages share this title`, {
          title: page.title,
        })
      : null;
  },
  (page) =>
    page.metaDescription
      ? null
      : issue('meta_description_missing', 'warning', 'Page has no meta description'),
  (page) => (page.h1s.length === 0 ? issue('h1_missing', 'error', 'Page has no H1 heading') : null),
  (page) =>
    page.h1s.length > 1
      ? issue('h1_multiple', 'warning', `Page has ${page.h1s.length} H1 headings`, {
          h1s: page.h1s,
        })
      : null,
  (page) =>
    page.canonical ? null : issue('canonical_missing', 'warning', 'Page has no canonical URL'),
  (page) => {
    if (!page.canonical) return null;
    const canonical = absolute(page.canonical, page.url);
    return canonical && canonical !== stripHash(page.url)
      ? issue('canonical_mismatch', 'warning', 'Canonical URL points to a different page', {
          canonical,
        })
      : null;
  },
  (page) =>
    page.wordCount < THIN_CONTENT_WORDS && page.wordCount >= 50
      ? issue('thin_content', 'warning', `Only ${page.wordCount} words of main content`, {
          words: page.wordCount,
        })
      : null,
  (page) =>
    page.wordCount < 50 && page.scriptCount > 0
      ? issue(
          'client_rendered',
          'warning',
          'Almost no text in the HTML: content is likely rendered by JavaScript, which crawlers may not see',
          { words: page.wordCount, scripts: page.scriptCount },
        )
      : null,
  (page) =>
    page.imagesMissingAlt.length > 0
      ? issue(
          'images_missing_alt',
          'warning',
          `${page.imagesMissingAlt.length} of ${page.imagesTotal} images have no alt text`,
          { images: page.imagesMissingAlt.slice(0, 10) },
        )
      : null,
  (page) =>
    page.insecureResources > 0
      ? issue(
          'mixed_content',
          'warning',
          `${page.insecureResources} resources load over plain http`,
          {
            count: page.insecureResources,
          },
        )
      : null,
];

export function findIssues(page: PageFacts, site: SiteContext): SeoIssue[] {
  return RULES.map((rule) => rule(page, site)).filter((found): found is SeoIssue => found !== null);
}

/** A page from the sitemap that couldn't be fetched is itself the issue. */
export function fetchFailureIssue(status: number | null, reason: string): SeoIssue {
  return status
    ? issue('http_error', 'error', `URL listed in the sitemap returns HTTP ${status}`, { status })
    : issue('http_error', 'error', `URL listed in the sitemap could not be fetched: ${reason}`);
}

export function buildSiteContext(pages: PageFacts[]): SiteContext {
  const titleCounts = new Map<string, number>();
  for (const { title } of pages)
    if (title) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  return { titleCounts };
}

function absolute(href: string, base: string): string | null {
  try {
    return stripHash(new URL(href, base).toString());
  } catch {
    return null;
  }
}

function stripHash(url: string): string {
  return url.split('#')[0] ?? url;
}
