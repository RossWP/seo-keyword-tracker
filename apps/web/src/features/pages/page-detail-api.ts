import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { apiRequest } from '../../api/client';

const pageDetail = z.object({
  id: z.string(),
  url: z.string(),
  finalUrl: z.string().nullable(),
  title: z.string().nullable(),
  metaDescription: z.string().nullable(),
  h1: z.string().nullable(),
  wordCount: z.number().nullable(),
  fetchStatus: z.string(),
  fetchError: z.string().nullable(),
  httpStatus: z.number().nullable(),
  fetchedAt: z.string(),
  client: z.object({ id: z.string(), name: z.string() }),
  keywords: z.array(
    z.object({
      id: z.number(),
      term: z.string(),
      score: z.number(),
      sources: z.array(z.string()),
      position: z.number().nullable(),
      date: z.string().nullable(),
    }),
  ),
  issues: z.array(
    z.object({
      code: z.string(),
      severity: z.enum(['error', 'warning', 'notice']),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).nullable(),
    }),
  ),
});

const history = z.object({
  timezone: z.string(),
  from: z.string(),
  to: z.string(),
  series: z.array(
    z.object({
      keywordId: z.number(),
      term: z.string(),
      points: z.array(z.object({ date: z.string(), position: z.number().nullable() })),
    }),
  ),
});

export type PageDetail = z.infer<typeof pageDetail>;
export type RankHistory = z.infer<typeof history>;

export function usePageDetail(pageId: string) {
  return useQuery({
    queryKey: ['page', pageId],
    queryFn: ({ signal }) =>
      apiRequest(`/pages/${encodeURIComponent(pageId)}`, pageDetail, { signal }),
  });
}

export function usePageHistory(pageId: string, range: { from: string; to: string } | null) {
  return useQuery({
    queryKey: ['page-history', pageId, range],
    queryFn: ({ signal }) => {
      const search = new URLSearchParams(range ?? {});
      return apiRequest(
        `/pages/${encodeURIComponent(pageId)}/rankings?${search.toString()}`,
        history,
        {
          signal,
        },
      );
    },
    enabled: range !== null,
    placeholderData: keepPreviousData,
  });
}
