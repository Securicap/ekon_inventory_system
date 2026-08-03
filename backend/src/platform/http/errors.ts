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

export const forbidden = (capability: string): AppError =>
  new AppError('FORBIDDEN', `Missing capability: ${capability}`);

export const unauthenticated = (): AppError =>
  new AppError('UNAUTHENTICATED', 'Authentication required');

export const conflict = (message: string): AppError => new AppError('CONFLICT', message);
