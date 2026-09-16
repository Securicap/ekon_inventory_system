import { describe, expect, it } from 'vitest';
import { parseBackupFileName, type ParsedBackupName } from '../../../src/cli/backup/naming.js';
import { isoWeekKey, selectBackupsToPrune, utcDayKey } from '../../../src/cli/backup/retention.js';

/**
 * Retention is the one piece of the backup system that destroys data, so it is
 * a pure function and it is tested exhaustively. Everything these tests assert
 * about what is *kept* is a guarantee about a shop's ability to recover.
 */

/** `2026-09-15T03:15Z` -> the parsed backup a directory listing would yield. */
function at(iso: string, tag?: string): ParsedBackupName {
  const stamp = new Date(iso)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const name = tag === undefined ? `ekon-${stamp}.dump` : `ekon-${stamp}-${tag}.dump`;
  const parsed = parseBackupFileName(name);
  if (parsed === null) throw new Error(`fixture is not a backup name: ${name}`);
  return parsed;
}

const names = (backups: readonly ParsedBackupName[]): string[] => backups.map((b) => b.name);

/** One backup a day, newest first, ending today. */
function daily(days: number, until = '2026-09-15T03:00:00Z'): ParsedBackupName[] {
  const end = new Date(until).getTime();
  return Array.from({ length: days }, (_, index) =>
    at(new Date(end - index * 86_400_000).toISOString()),
  );
}

describe('isoWeekKey', () => {
  it('starts weeks on Monday', () => {
    // 2026-09-14 is a Monday; the Sunday before it belongs to the week before.
    expect(isoWeekKey(new Date('2026-09-14T00:00:00Z'))).toBe(
      isoWeekKey(new Date('2026-09-20T23:59:59Z')),
    );
    expect(isoWeekKey(new Date('2026-09-13T23:59:59Z'))).not.toBe(
      isoWeekKey(new Date('2026-09-14T00:00:00Z')),
    );
  });

  it('uses the ISO year, not the calendar year, at the turn of it', () => {
    // 2027-01-01 is a Friday, so it is in week 53 of ISO year 2026. A rule that
    // read the calendar year would put it in "2027-W53" and lose a week's
    // backup once a year, silently.
    expect(isoWeekKey(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
    expect(isoWeekKey(new Date('2026-12-31T12:00:00Z'))).toBe('2026-W53');
    expect(isoWeekKey(new Date('2027-01-04T12:00:00Z'))).toBe('2027-W01');
  });
});

describe('utcDayKey', () => {
  it('groups by UTC, so a shop and a support session agree about which day it is', () => {
    expect(utcDayKey(new Date('2026-09-15T00:00:00Z'))).toBe('20260915');
    expect(utcDayKey(new Date('2026-09-15T23:59:59Z'))).toBe('20260915');
  });
});

describe('selectBackupsToPrune', () => {
  const policy = { keepDaily: 14, keepWeekly: 8 };

  it('keeps everything while there is less than the daily window', () => {
    expect(selectBackupsToPrune(daily(14), policy)).toEqual([]);
  });

  it('counts days that have a backup, not calendar days', () => {
    // The case a naive "older than fourteen days" rule gets catastrophically
    // wrong: a shop that was shut for a fortnight comes back to its backups,
    // not to an empty directory.
    const old = [
      at('2025-01-05T03:00:00Z'),
      at('2025-01-04T03:00:00Z'),
      at('2025-01-03T03:00:00Z'),
    ];
    expect(selectBackupsToPrune(old, policy)).toEqual([]);
  });

  it('keeps one backup a day inside the window and one a week outside it', () => {
    const backups = daily(60);
    const kept = new Set(
      names(backups).filter((name) => !names(selectBackupsToPrune(backups, policy)).includes(name)),
    );

    // 14 daily keepers, plus one per ISO week for 8 weeks. The most recent
    // weeks' keepers are already daily keepers, so the total is below 22.
    expect(kept.size).toBeGreaterThanOrEqual(14);
    expect(kept.size).toBeLessThanOrEqual(22);

    // The newest fourteen are all there.
    for (const backup of backups.slice(0, 14)) expect(kept.has(backup.name)).toBe(true);
    // And something survives from more than a month ago.
    expect([...kept].some((name) => name < backups[40]!.name)).toBe(true);
  });

  it('keeps only the newest backup of a day that has several', () => {
    // A manual backup before a risky change is cheap because of this. If it
    // should outlive the day, it gets a tag.
    const backups = [
      at('2026-09-15T18:00:00Z'),
      at('2026-09-15T03:00:00Z'),
      at('2026-09-15T12:00:00Z'),
    ];
    const pruned = selectBackupsToPrune(backups, { keepDaily: 1, keepWeekly: 0 });
    expect(names(pruned).sort()).toEqual([
      'ekon-20260915T030000Z.dump',
      'ekon-20260915T120000Z.dump',
    ]);
  });

  it('never prunes a tagged backup, however old or however many', () => {
    const backups = [
      ...daily(3),
      at('2020-01-01T03:00:00Z', 'before-upgrade'),
      at('2019-06-01T03:00:00Z', 'first-inventory'),
      at('2019-06-01T04:00:00Z', 'second'),
    ];
    const pruned = selectBackupsToPrune(backups, { keepDaily: 1, keepWeekly: 0 });
    for (const name of names(pruned)) expect(name).not.toMatch(/-(before-upgrade|first|second)/);
  });

  it('does not let a tagged backup fill a day or a week bucket', () => {
    // A tag marks a backup as permanent. It must not also *consume* a keeper
    // slot, or tagging one would quietly shorten the ordinary retention.
    const backups = [at('2026-09-15T18:00:00Z', 'tagged'), at('2026-09-15T03:00:00Z')];
    expect(selectBackupsToPrune(backups, { keepDaily: 1, keepWeekly: 0 })).toEqual([]);
  });

  it('keeps nothing weekly when the weekly count is zero', () => {
    const backups = daily(30);
    const pruned = selectBackupsToPrune(backups, { keepDaily: 7, keepWeekly: 0 });
    expect(pruned).toHaveLength(23);
  });

  it('is stable regardless of the order the directory was read in', () => {
    const backups = daily(30);
    const shuffled = [...backups].reverse();
    expect(names(selectBackupsToPrune(backups, policy)).sort()).toEqual(
      names(selectBackupsToPrune(shuffled, policy)).sort(),
    );
  });

  it('prunes nothing from an empty directory', () => {
    expect(selectBackupsToPrune([], policy)).toEqual([]);
  });
});
