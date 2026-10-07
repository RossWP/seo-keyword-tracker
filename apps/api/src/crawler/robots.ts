import robotsParserModule from 'robots-parser';

export interface Robots {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
  getCrawlDelay(userAgent?: string): number | undefined;
  getSitemaps(): string[];
}

// robots-parser is CommonJS and its bundled types don't describe the ESM default import,
// which at runtime is the parser function itself.
const parse = robotsParserModule as unknown as (url: string, contents: string) => Robots;

export function parseRobots(robotsUrl: string, contents: string): Robots {
  return parse(robotsUrl, contents);
}
