import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useMemo, useState, type ReactNode } from 'react';
import type { AuthenticatedUser } from '@ekon/shared';
import { AUTH_ME_QUERY_KEY, getCurrentUser, isAuthQueryKey } from './authApi.js';

/**
 * The one place the application knows whether anybody is signed in.
 *
 * Four states, not `user | null`. `null` cannot say whether we are still asking
 * the server, and an application that cannot tell those apart either flashes
 * protected content at somebody who is not signed in or shows a login form to
 * somebody who is.
 *
 * The server session is the source of truth, and it is asked on every page
 * load. Nothing about the user is written to `localStorage`, `sessionStorage`,
 * IndexedDB, or a cookie: a copy kept in the browser would be a second answer
 * to "who is this", it would survive a revocation, and it would still be there
 * on a shared shop laptop after somebody walked away. A refresh re-asks
 * `/api/auth/me`, which costs one indexed lookup and is always current.
 */
export type AuthState =
  | { status: 'loading' }
  | { status: 'authenticated'; user: AuthenticatedUser }
  | { status: 'unauthenticated'; reason: UnauthenticatedReason }
  | { status: 'error'; error: unknown };

/**
 * Why nobody is signed in. It changes only what the login screen *says*, never
 * what it does.
 *
 * `never-signed-in` is the first visit — the ordinary case, and the one that
 * must not be greeted with "your session ended", which would be a lie to
 * somebody who simply opened the application. The other two are things this
 * browser watched happen, so they can be stated honestly.
 */
export type UnauthenticatedReason = 'never-signed-in' | 'signed-out' | 'session-ended';

export interface AuthContextValue {
  state: AuthState;
  /** Adopt the user a successful sign-in returned. */
  completeSignIn: (user: AuthenticatedUser) => void;
  /** The server confirmed the session is revoked. Drop everything it opened. */
  completeSignOut: () => void;
  /** A protected request was refused as unauthenticated: the session ended. */
  reportSessionEnded: () => void;
  /** Ask the server again after the bootstrap failed to reach it. */
  retryBootstrap: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState<UnauthenticatedReason>('never-signed-in');

  const me = useQuery({
    queryKey: AUTH_ME_QUERY_KEY,
    queryFn: ({ signal }) => getCurrentUser(signal),
    /**
     * Asked once and then only when something asks it to be. There is no
     * polling and no interval: a revocation, a demotion, or a deactivation
     * lands on the next protected request the person makes, which is the
     * moment it matters, and a background `/me` every minute would be a
     * request per browser per minute forever to learn nothing.
     */
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    /**
     * No automatic retry, deliberately, and against the read policy the rest of
     * the application uses. A 401 is not an error here at all — it is `null`
     * data — so nothing retries it. What is left is an unreachable server, and
     * this is the first thing on the screen: a chain of backed-off retries
     * makes the application look frozen to somebody who is standing there and
     * can press a button. They get an honest message and that button.
     */
    retry: false,
  });

  /**
   * Everything a session opened, dropped in one place.
   *
   * The auth entry itself is *set* rather than removed: removing it would leave
   * this query's observer with no data and start a refetch behind the login
   * screen, asking a question we already know the answer to.
   */
  const endSession = useCallback(
    (next: Exclude<UnauthenticatedReason, 'never-signed-in'>) => {
      setReason(next);
      queryClient.removeQueries({ predicate: (query) => !isAuthQueryKey(query.queryKey) });
      queryClient.setQueryData(AUTH_ME_QUERY_KEY, null);
    },
    [queryClient],
  );

  const completeSignIn = useCallback(
    (user: AuthenticatedUser) => {
      // The login response is the same shape `/me` returns, so it is the
      // bootstrap answer — no second round trip to learn what we were just
      // told.
      queryClient.setQueryData(AUTH_ME_QUERY_KEY, user);
    },
    [queryClient],
  );

  const completeSignOut = useCallback(() => endSession('signed-out'), [endSession]);

  const reportSessionEnded = useCallback(() => {
    // Only meaningful while somebody is signed in. A 401 arriving after the
    // login screen is already up would otherwise re-announce an ended session
    // to somebody who is trying to start a new one.
    if (queryClient.getQueryData(AUTH_ME_QUERY_KEY) == null) return;
    endSession('session-ended');
  }, [endSession, queryClient]);

  const retryBootstrap = useCallback(() => {
    void queryClient.refetchQueries({ queryKey: AUTH_ME_QUERY_KEY });
  }, [queryClient]);

  const state = useMemo<AuthState>(() => {
    // `isPending` covers the first ask; a refetch after a failure keeps the
    // status at `error` while it is in flight, and that is still waiting.
    if (me.isPending || (me.isError && me.isFetching)) return { status: 'loading' };
    if (me.isError) return { status: 'error', error: me.error };
    return me.data
      ? { status: 'authenticated', user: me.data }
      : { status: 'unauthenticated', reason };
  }, [me.isPending, me.isError, me.isFetching, me.error, me.data, reason]);

  const value = useMemo<AuthContextValue>(
    () => ({ state, completeSignIn, completeSignOut, reportSessionEnded, retryBootstrap }),
    [state, completeSignIn, completeSignOut, reportSessionEnded, retryBootstrap],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
