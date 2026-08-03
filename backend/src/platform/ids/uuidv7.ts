import { uuidv7 as generate } from 'uuidv7';

/**
 * All identifiers are UUIDv7: time-ordered, so B-tree inserts stay sequential
 * and ids sort chronologically, and globally unique, so a browser can generate
 * one offline without risking a collision when it eventually reaches the
 * server.
 *
 * Ids are generated in application code rather than by the database precisely
 * so that the offline milestone can move generation to the client without a
 * schema change.
 */
export function newId(): string {
  return generate();
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
