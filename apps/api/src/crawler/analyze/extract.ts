import * as cheerio from 'cheerio';

/** Everything the keyword and issue logic needs from one fetched HTML page. */
export interface PageFacts {
  url: string;
  title: string | null;
  metaDescription: string | null;
  h1s: string[];
  /** h2–h3 text, in document order. */
  headings: string[];
  canonical: string | null;
  /** Combined meta robots and X-Robots-Tag, lowercased. */
  robots: string;
  lang: string | null;
  jsonLdTypes: string[];
  jsonLdKeywords: string[];
  imagesTotal: number;
  imagesMissingAlt: string[];
  insecureResources: number;
  mainText: string;
  wordCount: number;
  scriptCount: number;
}

const BLOCKS =
  'p, div, section, li, h1, h2, h3, h4, h5, h6, br, td, th, blockquote, pre, dt, dd, figcaption';
const NOISE =
  'script, style, noscript, svg, template, iframe, nav, header, footer, aside, form, dialog';

export function extractPage(
  html: string,
  url: string,
  xRobotsTag: string | null = null,
): PageFacts {
  const $ = cheerio.load(html);
  const text = (value: string | undefined) => value?.replace(/\s+/g, ' ').trim() ?? '';
  const nonEmpty = (value: string) => (value === '' ? null : value);

  const jsonLd = $('script[type="application/ld+json"]')
    .toArray()
    .flatMap((element) => parseJsonLd($(element).text()));
  const images = $('img').toArray();
  const insecure = $(
    'img[src^="http:"], script[src^="http:"], link[rel="stylesheet"][href^="http:"], iframe[src^="http:"]',
  );
  const scriptCount = $('script[src]').length;

  // Main content: the article if marked up, else <main>, else the body without page chrome.
  const content = $('article').first().length
    ? $('article').first()
    : $('main').first().length
      ? $('main').first()
      : $('body');
  const contentCopy = content.clone();
  contentCopy.find(NOISE).remove();
  // Block elements would otherwise glue together ("Keyword ResearchKeyword research shows…").
  contentCopy.find(BLOCKS).after(' ');
  const mainText = text(contentCopy.text());

  return {
    url,
    title: nonEmpty(text($('head > title').first().text() || $('title').first().text())),
    metaDescription: nonEmpty(text($('meta[name="description" i]').attr('content'))),
    h1s: $('h1')
      .toArray()
      .map((element) => text($(element).text()))
      .filter(Boolean),
    headings: $('h2, h3')
      .toArray()
      .map((element) => text($(element).text()))
      .filter(Boolean),
    canonical: nonEmpty(text($('link[rel="canonical" i]').attr('href'))),
    robots: [text($('meta[name="robots" i]').attr('content')), xRobotsTag ?? '']
      .join(',')
      .toLowerCase(),
    lang: nonEmpty(text($('html').attr('lang'))),
    jsonLdTypes: jsonLd.flatMap((node) => toStrings(node['@type'])),
    jsonLdKeywords: jsonLd
      .flatMap((node) => toStrings(node.keywords).flatMap((value) => value.split(',')))
      .map((value) => value.trim())
      .filter(Boolean),
    imagesTotal: images.length,
    imagesMissingAlt: images
      .filter((element) => $(element).attr('alt') === undefined)
      .map((element) => $(element).attr('src') ?? '(no src)'),
    insecureResources: url.startsWith('https:') ? insecure.length : 0,
    mainText,
    wordCount: countWords(mainText),
    scriptCount,
  };
}

export function countWords(value: string): number {
  return value.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

type JsonLdNode = Record<string, unknown>;

/** JSON-LD may be one node, an array, or a @graph; broken JSON is ignored. */
function parseJsonLd(raw: string): JsonLdNode[] {
  try {
    const data: unknown = JSON.parse(raw);
    const nodes = Array.isArray(data) ? data : [data];
    return nodes.flatMap((node): JsonLdNode[] => {
      if (!isRecord(node)) return [];
      const graph = node['@graph'];
      return Array.isArray(graph) ? graph.filter(isRecord) : [node];
    });
  } catch {
    return [];
  }
}

const isRecord = (value: unknown): value is JsonLdNode =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function toStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
