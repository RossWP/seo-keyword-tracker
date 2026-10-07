import type { PageFacts } from './extract.js';
import { STOPWORDS } from './stopwords.js';

export type KeywordSource =
  'title' | 'h1' | 'slug' | 'heading' | 'meta' | 'intro' | 'schema' | 'body';

export interface KeywordPick {
  term: string;
  score: number;
  /** Where the phrase was found, strongest first: the "why" shown in the UI. */
  sources: KeywordSource[];
}

/** How much one appearance in each place says about what the page is about. */
const SOURCE_WEIGHTS: Record<Exclude<KeywordSource, 'body'>, number> = {
  title: 3,
  h1: 3,
  slug: 2.5,
  schema: 2,
  heading: 1.5,
  meta: 1.5,
  intro: 1.2,
};
const MAX_KEYWORDS = 8;
const MIN_SCORE = 2;
const INTRO_WORDS = 50;
const BODY_ONLY_WEIGHT = 0.5;

/**
 * Picks up to 8 keyword phrases per page. Phrases (1–4 words) are scored by where they
 * appear (title, H1, URL slug, headings, …) plus how often they occur in the body, favour
 * 2–3 word phrases (typical search queries), and are discounted when they appear on many
 * pages of the same site (IDF), so a brand name on every page sinks.
 */
export function extractKeywords(pages: PageFacts[]): KeywordPick[][] {
  const brand = brandWords(pages);
  const candidates = pages.map((page) => collectCandidates(page, brand));
  const documentFrequency = new Map<string, number>();
  for (const page of candidates) {
    for (const term of page.keys())
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }

  return candidates.map((page) => {
    const scored = [...page.entries()]
      .map(([term, { sources, bodyCount }]) => {
        const locationScore = [...sources].reduce((sum, source) => sum + SOURCE_WEIGHTS[source], 0);
        if (locationScore === 0 && bodyCount < 3) return null;
        const words = term.split(' ').length;
        const lengthBonus = words === 2 || words === 3 ? 1.3 : words === 4 ? 1.1 : 1;
        const idf = Math.log((pages.length + 1) / ((documentFrequency.get(term) ?? 0) + 1)) + 1;
        // A phrase found only in body text is weaker evidence than one the author put in a title.
        const bodyWeight = locationScore === 0 ? BODY_ONLY_WEIGHT : 1;
        const score = (locationScore + Math.log1p(bodyCount) * bodyWeight) * lengthBonus * idf;
        const ordered = (Object.keys(SOURCE_WEIGHTS) as KeywordSource[]).filter((source) =>
          sources.has(source as Exclude<KeywordSource, 'body'>),
        );
        return { term, score, sources: bodyCount > 0 ? [...ordered, 'body' as const] : ordered };
      })
      .filter((pick): pick is KeywordPick => pick !== null && pick.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));

    return removeOverlaps(scored)
      .slice(0, MAX_KEYWORDS)
      .map((pick) => ({
        ...pick,
        score: Math.round(pick.score * 100) / 100,
      }));
  });
}

interface Candidate {
  sources: Set<Exclude<KeywordSource, 'body'>>;
  bodyCount: number;
}

function collectCandidates(page: PageFacts, brand: Set<string>): Map<string, Candidate> {
  const candidates = new Map<string, Candidate>();
  const isBrand = (term: string) => term.split(' ').some((word) => brand.has(word));
  const get = (term: string) => {
    let candidate = candidates.get(term);
    if (!candidate) {
      candidate = { sources: new Set(), bodyCount: 0 };
      candidates.set(term, candidate);
    }
    return candidate;
  };
  // Single words count only where the author chose them deliberately (title, H1, slug, headings).
  const addFrom = (source: Exclude<KeywordSource, 'body'>, texts: (string | null)[]) => {
    const runningText = source === 'meta' || source === 'intro';
    for (const text of texts) {
      for (const term of text ? phrases(text, { innerStopwords: !runningText }) : []) {
        if (isBrand(term) || (runningText && !term.includes(' '))) continue;
        get(term).sources.add(source);
      }
    }
  };

  addFrom('title', [stripSiteName(page.title)]);
  addFrom('h1', page.h1s);
  addFrom('slug', [slugText(page.url)]);
  addFrom('schema', page.jsonLdKeywords);
  addFrom('heading', page.headings);
  addFrom('meta', [page.metaDescription]);
  addFrom('intro', [page.mainText.split(/\s+/).slice(0, INTRO_WORDS).join(' ')]);
  // Body counts only for phrases that already exist; otherwise every body n-gram is a candidate.
  for (const term of phrases(page.mainText, { innerStopwords: false })) {
    const candidate = candidates.get(term);
    if (candidate) candidate.bodyCount++;
    else if (term.includes(' ') && !isBrand(term)) get(term).bodyCount++;
  }
  return candidates;
}

/**
 * All 1–4 word phrases that don't cross punctuation, start or end with a stopword or a number,
 * or end in a possessive. Stopwords inside a phrase ("data science for seo") are allowed only
 * in short, deliberate texts like titles; in running text they mostly produce fragments
 * ("analysis is the process").
 */
export function phrases(text: string, { innerStopwords = true } = {}): string[] {
  const result: string[] = [];
  const segments = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .split(/[.,;:!?()[\]{}"“”|/\\–—]+|\s-\s/u);
  for (const segment of segments) {
    const words = segment.match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) ?? [];
    for (let start = 0; start < words.length; start++) {
      for (let length = 1; length <= 4 && start + length <= words.length; length++) {
        const slice = words.slice(start, start + length);
        const first = slice[0] ?? '';
        const last = slice.at(-1) ?? '';
        if (STOPWORDS.has(first) || STOPWORDS.has(last)) continue;
        if (/^\d+$/.test(first) || /^\d+$/.test(last) || last.endsWith("'s")) continue;
        if (!innerStopwords && slice.some((word) => STOPWORDS.has(word))) continue;
        if (length === 1 && first.length < 3) continue;
        result.push(slice.join(' '));
      }
    }
  }
  return result;
}

const TITLE_SEPARATOR = /\s+[|•·–—-]\s+/;

/** "What is SEO? • Yoast" → "What is SEO?": the site name is not what a page is about. */
function stripSiteName(title: string | null): string | null {
  if (!title) return null;
  const parts = title.split(TITLE_SEPARATOR);
  return parts.length > 1 ? parts.slice(0, -1).join(' ') : title;
}

/**
 * The site's name, taken from the title suffix most pages share ("… | Acme"). Phrases containing
 * it are dropped: "Acme makes it simple" is marketing, not a keyword the page ranks for.
 */
function brandWords(pages: PageFacts[]): Set<string> {
  const suffixes = new Map<string, number>();
  for (const { title } of pages) {
    const parts = title?.split(TITLE_SEPARATOR) ?? [];
    const suffix = parts.length > 1 ? parts.at(-1)?.trim().toLowerCase() : undefined;
    if (suffix) suffixes.set(suffix, (suffixes.get(suffix) ?? 0) + 1);
  }
  const [top] = [...suffixes.entries()].sort((a, b) => b[1] - a[1]);
  if (!top || top[1] < Math.max(2, pages.length / 2)) return new Set();
  return new Set(phrases(top[0]).filter((term) => !term.includes(' ')));
}

function slugText(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '';
    return decodeURIComponent(last)
      .replace(/\.[a-z]+$/i, '')
      .replace(/[-_]+/g, ' ');
  } catch {
    return '';
  }
}

/** Keeps the stronger of overlapping phrases ("keyword research" vs "keyword research tools"). */
function removeOverlaps(sorted: KeywordPick[]): KeywordPick[] {
  const kept: KeywordPick[] = [];
  for (const pick of sorted) {
    const padded = ` ${pick.term} `;
    const overlaps = kept.some(
      ({ term }) => ` ${term} `.includes(padded) || padded.includes(` ${term} `),
    );
    if (!overlaps) kept.push(pick);
  }
  return kept;
}
