import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError, NetworkError } from '../lib/api.js';

/**
 * Query defaults are tuned for a shop on an unreliable connection.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Retry reads — a dropped connection should not become an error screen.
        retry: (failureCount, error) => {
          if (error instanceof NetworkError) return failureCount < 4;
          if (error instanceof ApiError && error.status >= 500) return failureCount < 2;
          return false; // 4xx is the server telling us something true.
        },
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 15_000),
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
      mutations: {
        // Writes are never retried automatically. The server makes retries safe
        // via operation ids, but the person at the counter should see that a
        // retry is happening rather than have it done behind their back.
        retry: false,
      },
    },
  });
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [client] = useState(createQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
