import { HTTP_STATUS_BY_ERROR_CODE, type ErrorCode } from '@ekon/shared';

/**
 * The only error type application code should throw deliberately. Anything else
 * reaching the error handler is a bug and becomes an opaque 500 with a request
 * id — internal detail is logged, never returned.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ReadonlyArray<{ path: string; message: string }> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    details?: ReadonlyArray<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = HTTP_STATUS_BY_ERROR_CODE[code];
    this.details = details;
  }
}

export const notFound = (what: string): AppError => new AppError('NOT_FOUND', `${what} not found`);

/**
 * The caller is signed in and may not do this.
 *
 * Says nothing about *why*: not which capability was required, not which roles
 * hold it, not who to ask. Naming the capability would describe the
 * authorization model to anyone probing endpoints, and the person at the
 * counter cannot act on it either — the answer to "you do not have permission"
 * is to ask the owner, not to read a policy. The request id in the envelope is
 * what turns a support call into a log line.
 */
export const forbidden = (): AppError =>
  new AppError('FORBIDDEN', 'You do not have permission to perform this action');

/**
 * Nobody is signed in — no cookie, or one that no longer resolves to a usable
 * session. Deliberately one message for all of those; see the identity module.
 */
export const unauthenticated = (): AppError =>
  new AppError('UNAUTHENTICATED', 'Authentication required');

export const conflict = (message: string): AppError => new AppError('CONFLICT', message);

/**
 * Fastify's content-type parser raises these codes when it cannot parse the
 * request body as JSON — a truncated or otherwise invalid document, or an empty
 * body where JSON was required. Both are client mistakes, so the error boundary
 * answers with a structured 400 rather than logging them as unexpected 500s.
 *
 * The set is deliberately narrow: it must not swallow unrelated 400s. Media-type
 * (415), content-length, and body-too-large (413) errors are not malformed JSON
 * and are intentionally excluded.
 */
const MALFORMED_JSON_BODY_ERROR_CODES: ReadonlySet<string> = new Set([
  'FST_ERR_CTP_INVALID_JSON_BODY',
  'FST_ERR_CTP_EMPTY_JSON_BODY',
]);

/** True when `error` is Fastify's malformed/invalid JSON request-body error. */
export function isMalformedJsonBodyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && MALFORMED_JSON_BODY_ERROR_CODES.has(code);
}
