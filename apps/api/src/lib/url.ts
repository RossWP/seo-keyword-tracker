/** A website a user entered, reduced to what identifies it. */
export interface WebsiteUrl {
  /** Normalised URL as entered: lowercase host, no credentials, query or fragment. */
  url: string;
  origin: string;
  /** Host without "www.", already punycoded by URL parsing: one site per user, however it's spelled. */
  siteKey: string;
}

/** Parses user input. Returns null for anything that isn't an absolute http(s) URL of a named host. */
export function parseWebsiteUrl(input: string): WebsiteUrl | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (!url.hostname.includes('.') && !url.hostname.startsWith('[')) return null;
  url.hash = '';
  url.search = '';
  return { url: url.toString(), origin: url.origin, siteKey: siteKeyOf(url.hostname) };
}

export function siteKeyOf(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '');
}

/** "yoast.com" and "www.yoast.com" are the same site. */
export function isSameSite(a: string | URL, b: string | URL): boolean {
  const hostA = typeof a === 'string' ? new URL(a).hostname : a.hostname;
  const hostB = typeof b === 'string' ? new URL(b).hostname : b.hostname;
  return siteKeyOf(hostA) === siteKeyOf(hostB);
}

const TRACKING_PARAM = /^(utm_[a-z]+|gclid|fbclid|mc_cid|mc_eid|ref)$/i;

/** Canonical form for deduplicating page URLs: no fragment, no tracking parameters. */
export function normalizePageUrl(input: string, base?: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim(), base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}
