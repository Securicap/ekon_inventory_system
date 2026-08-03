import { z } from 'zod';

/** Header carrying the client-generated, retry-stable operation id. */
export const OPERATION_ID_HEADER = 'x-ekon-operation-id';

/** Header carrying the browser installation id, generated once and persisted. */
export const DEVICE_ID_HEADER = 'x-ekon-device-id';

/** Correlates a client-visible failure with a server log line. */
export const REQUEST_ID_HEADER = 'x-request-id';

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  /** Highest applied migration; lets a deploy be verified without shell access. */
  schemaVersion: z.string().nullable(),
  database: z.enum(['up', 'down']),
  time: z.string().datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** Cursor pagination — never offset. Offsets drift as rows are appended. */
export const pageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
