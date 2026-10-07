import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiRequest, isApiError } from '../../api/client';

const userSchema = z.object({ id: z.string(), email: z.string(), timezone: z.string() });
const userResponse = z.object({ user: userSchema });

export type User = z.infer<typeof userSchema>;

export const sessionQueryKey = ['session'] as const;

/** The signed-in user, or null when there is no valid session. */
export function useSession() {
  return useQuery({
    queryKey: sessionQueryKey,
    queryFn: async ({ signal }): Promise<User | null> => {
      try {
        return (await apiRequest('/auth/me', userResponse, { signal })).user;
      } catch (error) {
        if (isApiError(error, 401)) return null;
        throw error;
      }
    },
    staleTime: Infinity,
    retry: false,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (credentials: { email: string; password: string }) =>
      apiRequest('/auth/login', userResponse, { method: 'POST', body: credentials }),
    onSuccess: ({ user }) => {
      // A session that expired leaves the previous user's answers in the cache; whoever signs
      // in next must never see them, even for a moment.
      removeUserData(queryClient);
      queryClient.setQueryData(sessionQueryKey, user);
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest('/auth/logout', z.undefined(), { method: 'POST' }),
    onSettled: () => {
      // Signing out flips the session to null (RequireAuth then shows login) and drops
      // every cached answer that belonged to this user.
      queryClient.setQueryData(sessionQueryKey, null);
      removeUserData(queryClient);
    },
  });
}

/** Drops every cached answer that belongs to a user (all but the session and API health). */
function removeUserData(queryClient: QueryClient): void {
  queryClient.removeQueries({
    predicate: ({ queryKey: [key] }) => key !== sessionQueryKey[0] && key !== 'health',
  });
}
