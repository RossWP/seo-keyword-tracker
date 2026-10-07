import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { apiRequest } from '../../api/client';

export const crawlStatuses = [
  'pending',
  'discovering',
  'crawling',
  'done',
  'partial',
  'failed',
] as const;
export type CrawlStatus = (typeof crawlStatuses)[number];

const clientSchema = z.object({
  id: z.string(),
  name: z.string(),
  websiteUrl: z.string(),
  crawlStatus: z.enum(crawlStatuses),
  crawlErrorCode: z.string().nullable(),
  crawlErrorMessage: z.string().nullable(),
  pagesTotal: z.number(),
  pagesDone: z.number(),
  sitemapUrl: z.string().nullable(),
  createdAt: z.string(),
  crawlFinishedAt: z.string().nullable(),
});

export type Client = z.infer<typeof clientSchema>;

export const isCrawling = (status: CrawlStatus): boolean =>
  status === 'pending' || status === 'discovering' || status === 'crawling';

export const clientsQueryKey = ['clients'] as const;

/** The user's clients; polls every 3 s only while one of them is being crawled. */
export function useClients() {
  return useQuery({
    queryKey: clientsQueryKey,
    queryFn: async ({ signal }) =>
      (await apiRequest('/clients', z.object({ items: z.array(clientSchema) }), { signal })).items,
    refetchInterval: (query) =>
      query.state.status !== 'error' &&
      query.state.data?.some((client) => isCrawling(client.crawlStatus))
        ? 3_000
        : false,
  });
}
