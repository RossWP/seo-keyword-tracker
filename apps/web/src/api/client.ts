import { z } from 'zod';

const errorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

/** An error answer from our API (or a network failure, with status 0). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

/** Calls `/api{path}`, maps error envelopes to `ApiError`, and validates success bodies with `schema`. */
export async function apiRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  { method = 'GET', body, signal }: RequestOptions = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      signal: signal ?? null,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(0, 'network_error', 'Cannot reach the server. Check your connection.');
  }

  const data: unknown =
    response.status === 204 ? undefined : await response.json().catch(() => null);
  if (!response.ok) {
    const envelope = errorEnvelope.safeParse(data);
    if (envelope.success) {
      const { code, message, details } = envelope.data.error;
      throw new ApiError(response.status, code, message, details);
    }
    throw new ApiError(response.status, 'http_error', `Request failed (${response.status})`);
  }
  return schema.parse(data);
}

export const isApiError = (error: unknown, status?: number): error is ApiError =>
  error instanceof ApiError && (status === undefined || error.status === status);
