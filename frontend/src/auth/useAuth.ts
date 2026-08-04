import { useContext } from 'react';
import type { AuthenticatedUser } from '@ekon/shared';
import { AuthContext, type AuthContextValue } from './AuthProvider.js';

/** Authentication state and the four transitions that change it. */
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

/**
 * The signed-in person, for a screen that only ever renders inside the
 * authenticated shell.
 *
 * It throws rather than returning `null`, so a screen never has to write a
 * branch for a case its own placement has already ruled out — and if one is
 * ever mounted outside the boundary, that is a programming error and fails
 * loudly instead of rendering an empty header.
 */
export function useAuthenticatedUser(): AuthenticatedUser {
  const { state } = useAuth();
  if (state.status !== 'authenticated') {
    throw new Error('useAuthenticatedUser must be used inside the authenticated shell');
  }
  return state.user;
}
