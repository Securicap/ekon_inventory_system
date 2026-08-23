import { describe, expect, it } from 'vitest';
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
} from '../../../src/modules/inventory/domain/historyCursor.js';
import { AppError } from '../../../src/platform/http/errors.js';

/**
 * The cursor is a position in the ledger's order, and the properties that
 * matter are that it round-trips exactly and that nothing else is accepted as
 * one.
 */

const POSITION = {
  recordedAt: '2026-08-03 12:00:00.123456+00',
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01',
};

describe('history cursor', () => {
  it('round-trips a position exactly', () => {
    expect(decodeHistoryCursor(encodeHistoryCursor(POSITION))).toEqual(POSITION);
  });

  it('keeps microsecond precision', () => {
    // The reason the cursor carries PostgreSQL's own text rather than an ISO
    // string: a value rounded to milliseconds would, on a row written with
    // finer precision, either skip a movement or return one twice.
    const decoded = decodeHistoryCursor(encodeHistoryCursor(POSITION));
    expect(decoded.recordedAt).toBe('2026-08-03 12:00:00.123456+00');
  });

  it('handles a timestamp with no fractional part', () => {
    const position = { ...POSITION, recordedAt: '2026-08-03 12:00:00+00' };
    expect(decodeHistoryCursor(encodeHistoryCursor(position))).toEqual(position);
  });

  it('is url-safe, so it survives a query string untouched', () => {
    const cursor = encodeHistoryCursor(POSITION);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });

  it('does not look structured, so nobody is tempted to build one', () => {
    expect(encodeHistoryCursor(POSITION)).not.toContain('|');
    expect(encodeHistoryCursor(POSITION)).not.toContain(POSITION.id);
  });

  it('refuses anything it did not issue, as a field-level validation failure', () => {
    for (const cursor of [
      'not-base64!!',
      Buffer.from('no-separator', 'utf8').toString('base64url'),
      Buffer.from('2026-08-03 12:00:00+00|not-a-uuid', 'utf8').toString('base64url'),
      Buffer.from('yesterday|0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01', 'utf8').toString('base64url'),
      Buffer.from('|', 'utf8').toString('base64url'),
    ]) {
      let thrown: unknown;
      try {
        decodeHistoryCursor(cursor);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `cursor ${cursor} was accepted`).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe('VALIDATION_FAILED');
      expect((thrown as AppError).details?.[0]?.path).toBe('cursor');
    }
  });

  it('refuses a timestamp that only looks like one', () => {
    // A SQL fragment must never reach the database as a timestamp literal.
    const cursor = Buffer.from(
      `2026-08-03 12:00:00+00'; DROP TABLE inventory_movements; --|${POSITION.id}`,
      'utf8',
    ).toString('base64url');
    expect(() => decodeHistoryCursor(cursor)).toThrow(AppError);
  });
});
