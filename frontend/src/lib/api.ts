import { OPERATION_ID_HEADER, errorBodySchema, type ErrorCode } from '@ekon/shared';

/**
 * The single way this application talks to the server.
 *
 * Every state-changing call carries a caller-supplied operation id. Reads are
 * retried by TanStack Query; writes are never retried automatically, because
 * the user should see that a retry is happening even though the server makes it
 * safe.
 */

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly requestId: string;
  readonly details: ReadonlyArray<{ path: string; message: string }> | undefined;

  constructor(init: {
    code: ErrorCode;
    status: number;
    message: string;
    requestId: string;
    details?: ReadonlyArray<{ path: string; message: string }>;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId;
    this.details = init.details;
  }
}

/** Raised when the request never reached the server. Distinct from a 5xx. */
export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super('Network request failed');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

async function toError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  const parsed = errorBodySchema.safeParse(body);
  if (parsed.success) {
    return new ApiError({
      code: parsed.data.error.code,
      status: response.status,
      message: parsed.data.error.message,
      requestId: parsed.data.error.requestId,
      ...(parsed.data.error.details ? { details: parsed.data.error.details } : {}),
    });
  }

  return new ApiError({
    code: 'INTERNAL',
    status: response.status,
    message: `Unexpected response (${response.status})`,
    requestId: response.headers.get('x-request-id') ?? 'unknown',
  });
}

async function request<T>(
  method: string,
  path: string,
  options: { body?: unknown; operationId?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = {};

  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.operationId) headers[OPERATION_ID_HEADER] = options.operationId;

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    throw new NetworkError(cause);
  }

  if (!response.ok) throw await toError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal): Promise<T> =>
    request<T>('GET', path, signal ? { signal } : {}),

  /**
   * `operationId` is required, not optional. A write without one would be
   * unsafe to retry, and making the type system insist removes the possibility
   * of forgetting.
   */
  post: <T>(path: string, body: unknown, operationId: string): Promise<T> =>
    request<T>('POST', path, { body, operationId }),
};
