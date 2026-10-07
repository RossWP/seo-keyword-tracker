import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

/**
 * The user's clients; polls every 3 s only while one of them is being crawled. When a crawl
 * finishes, cached page lists are refreshed so its new pages show up without a reload.
 */
export function useClients() {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: clientsQueryKey,
    queryFn: async ({ signal }) => {
      const previous = queryClient.getQueryData<Client[]>(clientsQueryKey) ?? [];
      const { items } = await apiRequest('/clients', z.object({ items: z.array(clientSchema) }), {
        signal,
      });
      const finished = previous.some(
        (before) =>
          isCrawling(before.crawlStatus) &&
          items.some((now) => now.id === before.id && !isCrawling(now.crawlStatus)),
      );
      if (finished) void queryClient.invalidateQueries({ queryKey: ['pages'] });
      return items;
    },
    refetchInterval: (query) =>
      query.state.status !== 'error' &&
      query.state.data?.some((client) => isCrawling(client.crawlStatus))
        ? 3_000
        : false,
  });
}

export function useCreateClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (values: { name: string; websiteUrl: string }) =>
      apiRequest('/clients', clientSchema, { method: 'POST', body: values }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: clientsQueryKey }),
  });
}

export function useRecrawl() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (clientId: string) =>
      apiRequest(`/clients/${encodeURIComponent(clientId)}/recrawl`, clientSchema, {
        method: 'POST',
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: clientsQueryKey }),
  });
}

/** Plain-language reasons for each crawl failure code. */
export const CRAWL_ERRORS: Record<string, string> = {
  no_sitemap:
    'No sitemap was found: none listed in robots.txt works and the usual locations are missing.',
  no_blog_found: 'Sitemaps were found, but none of them lists blog posts.',
  blocked_by_site: 'The site refused the crawler (for example bot protection or rate limiting).',
  site_unreachable: 'The website did not respond or returned an error.',
  timeout: 'The website took too long to respond.',
  blocked_host: 'The address points to a private or internal network.',
  too_large: 'A response was too large to process.',
  too_many_redirects: 'The website redirects in a loop.',
  invalid_url: 'The website address is not valid.',
  internal_error: 'Something went wrong on our side while crawling.',
};
