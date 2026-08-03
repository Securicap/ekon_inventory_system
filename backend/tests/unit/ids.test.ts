import { describe, expect, it } from 'vitest';
import { isUuid, newId } from '../../src/platform/ids/uuidv7.js';

describe('newId', () => {
  it('produces well-formed uuids', () => {
    expect(isUuid(newId())).toBe(true);
  });

  it('sets the version 7 nibble', () => {
    // Position 14 of a canonical uuid string is the version.
    expect(newId()[14]).toBe('7');
  });

  it('produces ids that sort in creation order', () => {
    // This is why UUIDv7 rather than v4: index locality, and history that
    // sorts correctly without depending on a wall clock column.
    const ids = Array.from({ length: 500 }, () => newId());
    expect([...ids].sort()).toEqual(ids);
  });

  it('does not collide', () => {
    const ids = Array.from({ length: 10_000 }, () => newId());
    expect(new Set(ids).size).toBe(ids.length);
  });
});
