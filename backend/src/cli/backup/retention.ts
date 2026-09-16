import type { ParsedBackupName } from './naming.js';

/**
 * Which backups to delete, and — much more importantly — which never to.
 *
 * This is the one piece of the backup system that destroys data, so it is a
 * pure function over filenames: no filesystem, no clock, no configuration
 * lookup. It can be tested exhaustively, and the command that calls it deletes
 * exactly what it returns and nothing it inferred on its own.
 *
 * The rule is grandfather-father-son, stated in days and ISO weeks:
 *
 *   * keep the **newest** backup of each of the most recent `keepDaily` days
 *     that has one;
 *   * keep the **newest** backup of each of the most recent `keepWeekly` ISO
 *     weeks that has one;
 *   * keep every tagged backup, always;
 *   * delete the rest.
 *
 * Buckets are counted in *days that have a backup*, not in calendar days. An
 * installation that was switched off for a fortnight comes back to fourteen
 * backups, not to an empty directory — which is the case a naive "older than
 * fourteen days" rule gets catastrophically wrong, because the shop that was
 * closed is exactly the shop whose last backup matters most.
 *
 * A second backup taken on a day that already has one is prunable, and that is
 * deliberate: it is what makes a manual `ekon-ctl backup` before a risky change
 * cheap. If it should outlive the day, it gets a `--tag`, and then nothing here
 * will ever remove it.
 */

export interface RetentionPolicy {
  /** Distinct days to keep one backup from. */
  keepDaily: number;
  /** Distinct ISO weeks to keep one backup from. */
  keepWeekly: number;
}

/**
 * `2026-W38`. ISO 8601: weeks start on Monday, and week 1 is the one containing
 * the first Thursday of the year — which is why this shifts to the Thursday of
 * the backup's own week before reading the year off it. Using the calendar year
 * would put the 1st of January in week 53 of the wrong year, and a retention
 * rule that loses a week's backup once a year loses it silently.
 */
export function isoWeekKey(at: Date): string {
  const thursday = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  // getUTCDay(): Sunday is 0. Shift so Monday is 0, then step to Thursday.
  const dayFromMonday = (thursday.getUTCDay() + 6) % 7;
  thursday.setUTCDate(thursday.getUTCDate() - dayFromMonday + 3);

  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstDayFromMonday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayFromMonday + 3);

  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** `20260915` — the UTC day a backup belongs to. */
export function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * The backups that may be deleted, newest first in the same order they were
 * given.
 *
 * Everything not returned is kept. A caller that cannot decide what to do with
 * one of these should keep it: the failure mode of keeping too much is a full
 * disk, which is visible and recoverable, and the failure mode of deleting too
 * much is the business's records.
 */
export function selectBackupsToPrune(
  backups: readonly ParsedBackupName[],
  policy: RetentionPolicy,
): ParsedBackupName[] {
  // Newest first, by the stamp in the name rather than by anything the
  // filesystem claims: copying a directory onto a USB drive and back rewrites
  // every modification time.
  const ordered = [...backups].sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));

  const keep = new Set<string>();
  const daysSeen: string[] = [];
  const weeksSeen: string[] = [];

  for (const backup of ordered) {
    // A tag says somebody decided this one matters. Nothing here overrules that
    // — not age, not count, not the fact that its day already has a keeper.
    if (backup.tag !== null) {
      keep.add(backup.name);
      continue;
    }

    const day = utcDayKey(backup.takenAt);
    if (!daysSeen.includes(day)) {
      daysSeen.push(day);
      if (daysSeen.length <= policy.keepDaily) keep.add(backup.name);
    }

    const week = isoWeekKey(backup.takenAt);
    if (!weeksSeen.includes(week)) {
      weeksSeen.push(week);
      if (weeksSeen.length <= policy.keepWeekly) keep.add(backup.name);
    }
  }

  return ordered.filter((backup) => !keep.has(backup.name));
}
