import type { MessageKey } from '../i18n/index.js';
import { ApiError, NetworkError } from './api.js';

/**
 * One place that turns a failure into something a shop user can read.
 *
 * The server's `message` is English, for logs and developers, and is never
 * rendered. What the screen shows is chosen from the machine-readable status
 * and code, so the same failure reads the same way in Creole and in French.
 */
export function messageKeyForError(error: unknown): MessageKey {
  if (error instanceof NetworkError) return 'error.network';

  if (error instanceof ApiError) {
    // Somebody is signed in and may not do this. The remedy is to ask the
    // owner, not to sign in again — so it is never phrased as a session
    // problem, and it never signs anybody out.
    if (error.status === 403) return 'error.forbidden';
    if (error.status === 401) return 'error.sessionExpired';
    if (error.code === 'INSUFFICIENT_STOCK') return 'error.insufficientStock';
  }

  return 'error.generic';
}

/**
 * The correlation id, when the failure came back from the server with one. It
 * is what turns a support call into a log line, so it is shown next to the
 * message rather than kept in the console.
 */
export function requestIdForError(error: unknown): string | null {
  return error instanceof ApiError ? error.requestId : null;
}
