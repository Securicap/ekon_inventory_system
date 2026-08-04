import { useQuery, type QueryKey, type UseQueryResult } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ApiError } from '../lib/api.js';
import { useAuth } from './useAuth.js';

/**
 * A read that requires a session. Every business screen uses this instead of
 * `useQuery` directly.
 *
 * It exists for two rules that must hold identically everywhere, and that are
 * easy to forget one screen at a time:
 *
 *  - a protected read does not run before we know somebody is signed in, so
 *    opening the application never fires a request that can only be a 401;
 *  - a 401 *back* from one means the session ended — revoked, expired, or the
 *    account deactivated — and the application says so once and shows the login
 *    screen.
 *
 * The generic API client stays a generic API client: it knows about HTTP and
 * nothing about React or about who is signed in. This wrapper is the only join
 * between the two, and it is small enough to read in one go.
 *
 * Reporting the session as ended removes every protected query, so the read
 * that discovered it is gone and `enabled` is false besides. There is nothing
 * left to refire, which is what keeps an expired session from becoming a loop.
 */
export function useProtectedQuery<TData>(options: {
  queryKey: QueryKey;
  queryFn: (context: { signal: AbortSignal }) => Promise<TData>;
}): UseQueryResult<TData, Error> {
  const { state, reportSessionEnded } = useAuth();

  const result = useQuery({
    queryKey: options.queryKey,
    queryFn: options.queryFn,
    enabled: state.status === 'authenticated',
  });

  const sessionEnded = result.error instanceof ApiError && result.error.status === 401;

  useEffect(() => {
    if (sessionEnded) reportSessionEnded();
  }, [sessionEnded, reportSessionEnded]);

  return result;
}
