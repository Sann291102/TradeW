import { QueryClient } from '@tanstack/react-query';
import { logIfRateLimited, retryDelayMs, shouldRetry } from './sentinel/retryPolicy';
import { ApiError } from './api';

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  if (error.status === 429) return true;
  return error.status >= 500;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60 * 1000,
        gcTime: 30 * 60 * 1000,
        retry: (failureCount, error) => {
          logIfRateLimited(error, 'query');
          return shouldRetry(failureCount, error) && isRetryableError(error);
        },
        retryDelay: (attemptIndex, error) => retryDelayMs(attemptIndex, error),
        refetchOnWindowFocus: true,
        refetchOnMount: true,
        refetchOnReconnect: true,
        placeholderData: <T,>(previousData: T) => previousData,
      },
      mutations: {
        retry: (failureCount, error) => shouldRetry(failureCount, error, 1),
        retryDelay: (attemptIndex, error) => retryDelayMs(attemptIndex, error),
      },
    },
  });
}

let browserClient: QueryClient | null = null;

export function getQueryClient(): QueryClient {
  if (typeof window === 'undefined') return createQueryClient();
  if (!browserClient) browserClient = createQueryClient();
  return browserClient;
}

