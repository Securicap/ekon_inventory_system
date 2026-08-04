import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { AuthProvider } from '../auth/AuthProvider.js';
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

/**
 * The two providers the application runs inside: the query cache, and the
 * answer to who is signed in.
 *
 * `AuthProvider` is inside `QueryClientProvider` because it *is* a query — the
 * session is bootstrapped through `GET /api/auth/me` and cached like any other
 * read — and because signing out has to be able to drop every protected query
 * the session opened.
 *
 * `client` is accepted so a test can hold the same cache the application uses
 * and assert what signing out removed from it. Production passes nothing.
 */
export function AppProviders({ children, client }: { children: ReactNode; client?: QueryClient }) {
  const [queryClient] = useState(() => client ?? createQueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}
