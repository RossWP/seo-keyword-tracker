import { QueryCache, QueryClient } from '@tanstack/react-query';
import { isApiError } from './api/client';
import { sessionQueryKey } from './features/auth/auth-api';

/**
 * Any 401 from a data query means the session ended (expired or signed out elsewhere):
 * clearing the session sends the user to the login page via RequireAuth.
 */
export function createQueryClient(): QueryClient {
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (isApiError(error, 401) && query.queryKey[0] !== sessionQueryKey[0]) {
          queryClient.setQueryData(sessionQueryKey, null);
        }
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) =>
          failureCount < 2 && !(isApiError(error) && error.status >= 400 && error.status < 500),
      },
    },
  });
  return queryClient;
}
