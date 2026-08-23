import { AppError } from '../../../platform/http/errors.js';

/**
 * The pagination cursor: an exact position in the ledger's order.
 *
 * It carries the two values the feed is ordered by — `recorded_at` in
 * PostgreSQL's own text form, and the movement id — because those are what the
 * next page resumes strictly after. Nothing else is in it: not a page number,
 * not a filter, not a count. A cursor that encoded the filters would let a
 * caller change them mid-scan and get an incoherent answer while looking like
 * it had resumed.
 *
 * Base64url of `recordedAt|id`, and **opaque on purpose**. It is not encryption
 * and is not pretending to be — anyone can decode it, and there is nothing
 * secret in a timestamp and an id the same response already returned. What the
 * encoding buys is that it does not *look* structured, so a client is not
 * tempted to construct one, and the format can change without breaking anybody
 * who kept to the contract.
 *
 * A cursor that does not decode is a `VALIDATION_FAILED` naming the field, not
 * a `500` and not a silent fall back to the first page. Quietly starting over
 * would hand somebody paging through history a duplicate of everything they had
 * already read and no indication anything went wrong.
 */

export interface HistoryPosition {
  /** `recorded_at` exactly as PostgreSQL rendered it, microseconds included. */
  recordedAt: string;
  id: string;
}

const SEPARATOR = '|';

/** A uuid in any version. Ids are UUIDv7, but the shape is what is checked here. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `2026-08-03 12:00:00.123456+00` — PostgreSQL's text rendering of a
 * `timestamptz`. Checked before it is sent back to the database so a malformed
 * cursor is refused here rather than becoming a cast error inside a query.
 */
const PG_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

export function encodeHistoryCursor(position: HistoryPosition): string {
  return Buffer.from(`${position.recordedAt}${SEPARATOR}${position.id}`, 'utf8').toString(
    'base64url',
  );
}

export function decodeHistoryCursor(cursor: string): HistoryPosition {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = decoded.lastIndexOf(SEPARATOR);
  if (separator === -1) throw malformed();

  const recordedAt = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);

  if (!PG_TIMESTAMP_PATTERN.test(recordedAt) || !UUID_PATTERN.test(id)) throw malformed();

  return { recordedAt, id };
}

function malformed(): AppError {
  return new AppError('VALIDATION_FAILED', 'Request validation failed', [
    { path: 'cursor', message: 'Cursor is not one this endpoint issued' },
  ]);
}
