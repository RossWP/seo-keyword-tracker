import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';

const healthSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  database: z.enum(['up', 'down']),
});

export type ApiHealth = 'ok' | 'database_down' | 'unreachable';

// 503 is a valid health answer (API up, database down), so it is not treated as an error.
async function fetchHealth(signal: AbortSignal): Promise<ApiHealth> {
  try {
    const response = await fetch('/health', { signal, headers: { accept: 'application/json' } });
    if (response.status !== 200 && response.status !== 503) return 'unreachable';
    const health = healthSchema.parse(await response.json());
    return health.database === 'up' ? 'ok' : 'database_down';
  } catch (error) {
    if (signal.aborted) throw error;
    return 'unreachable';
  }
}

export function useApiHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => fetchHealth(signal),
    refetchInterval: 30_000,
  });
}
