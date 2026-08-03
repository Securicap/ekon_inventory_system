import { z } from 'zod';

/**
 * A closed set of machine-readable error codes. The frontend maps these to
 * translated messages; it must never parse an English error string.
 */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'SESSION_EXPIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'OPERATION_REPLAYED_WITH_DIFFERENT_BODY',
  'INSUFFICIENT_STOCK',
  'IMMUTABLE_RECORD',
  'RATE_LIMITED',
  'INTERNAL',
  'SERVICE_UNAVAILABLE',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorBodySchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    /** English, for logs and developers. Never rendered to a shop user. */
    message: z.string(),
    /** Field-level detail for VALIDATION_FAILED. */
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    /** Correlates a user-visible failure with a server log line. */
    requestId: z.string(),
  }),
});

export type ErrorBody = z.infer<typeof errorBodySchema>;

export const HTTP_STATUS_BY_ERROR_CODE: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  SESSION_EXPIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  OPERATION_REPLAYED_WITH_DIFFERENT_BODY: 409,
  INSUFFICIENT_STOCK: 422,
  IMMUTABLE_RECORD: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  SERVICE_UNAVAILABLE: 503,
};
