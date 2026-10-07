import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { apiRequest } from '../../api/client';

const keywordSummary = z.object({
  id: z.number(),
  term: z.string(),
  position: z.number().nullable(),
  date: z.string().nullable(),
});

const pageListItem = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string().nullable(),
  fetchStatus: z.string(),
  client: z.object({ id: z.string(), name: z.string() }),
  issueCount: z.number(),
  errorCount: z.number(),
  bestPosition: z.number().nullable(),
  keywords: z.array(keywordSummary),
});

const pageList = z.object({
  items: z.array(pageListItem),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export type PageListItem = z.infer<typeof pageListItem>;

export interface PageListParams {
  clientId: string;
  q: string;
  page: number;
}

export const PAGE_SIZE = 20;

export function usePages({ clientId, q, page }: PageListParams) {
  return useQuery({
    queryKey: ['pages', { clientId, q, page }],
    queryFn: ({ signal }) => {
      const search = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (clientId) search.set('clientId', clientId);
      if (q) search.set('q', q);
      return apiRequest(`/pages?${search.toString()}`, pageList, { signal });
    },
    // Keep the current rows on screen while the next page or search loads: no table flash.
    placeholderData: keepPreviousData,
  });
}
