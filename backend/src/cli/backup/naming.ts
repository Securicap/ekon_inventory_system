/**
 * What a backup file is called, and how to read a filename back.
 *
 * The name carries the timestamp, and it carries it in a form that sorts
 * lexicographically into chronological order: `ekon-20260915T031500Z.dump`.
 * That is not decoration. Retention, the "most recent backup" a restore reaches
 * for, and an operator reading `ls` all depend on being able to order a
 * directory of dumps without opening any of them, on a machine where the file
 * modification time may have been rewritten by a copy onto a USB drive.
 *
 * Always UTC, always `Z`, never local time. A shop in Haiti and a support
 * session in another timezone must read the same filename as the same moment,
 * and a local-time name would produce two files with the same name on the night
 * a clock goes back.
 */

const PREFIX = 'ekon-';
const EXTENSION = '.dump';

/**
 * `YYYYMMDDTHHMMSSZ` — ISO 8601 basic format, which is the only ISO form with
 * no colons in it. Colons are not legal in a Windows filename, and the product
 * is installed on Windows.
 */
const STAMP_PATTERN = /^\d{8}T\d{6}Z$/;

/**
 * What a `--tag` may contain.
 *
 * A tag ends up in a filename, so the rule is about what a filename can safely
 * hold: no separators, no dots, nothing that could climb out of the backup
 * directory or collide with the extension. Letters, digits, underscore, and
 * hyphen, starting with a letter or digit.
 *
 * A tag is also what makes a backup permanent — pruning never touches one — so
 * it is deliberately not free text: `before-upgrade` is a tag, and a sentence
 * about why somebody took it is not.
 */
const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export interface ParsedBackupName {
  /** The full filename, as it is on disk. */
  name: string;
  /** `20260915T031500Z`. */
  stamp: string;
  /** The `--tag` it was taken with, or `null`. */
  tag: string | null;
  /** The stamp as an instant, for grouping by day and by week. */
  takenAt: Date;
}

/** `2026-09-15T03:15:00Z` -> `20260915T031500Z`. */
export function backupStamp(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/** Throws unless `tag` is something that can safely live in a filename. */
export function assertUsableTag(tag: string): void {
  if (!TAG_PATTERN.test(tag)) {
    throw new Error(
      `--tag "${tag}" is not usable in a filename. Use letters, digits, "-", and "_" ` +
        '(at most 32 characters), starting with a letter or digit.',
    );
  }
}

/** `ekon-20260915T031500Z.dump`, or `ekon-20260915T031500Z-before-upgrade.dump`. */
export function backupFileName(stamp: string, tag?: string | null): string {
  if (tag !== undefined && tag !== null && tag !== '') {
    assertUsableTag(tag);
    return `${PREFIX}${stamp}-${tag}${EXTENSION}`;
  }
  return `${PREFIX}${stamp}${EXTENSION}`;
}

/**
 * The name a dump is written under while it is still being written.
 *
 * Dotted and suffixed, so it matches neither the glob a restore lists nor the
 * one retention prunes. A truncated dump that a crash left behind must never be
 * mistaken for a finished one — six months later, by somebody restoring it at
 * the worst moment. The finished name is applied by a rename, which is atomic
 * within a directory: a file with the final name is a complete file.
 */
export function partialFileName(finalName: string): string {
  return `.${finalName}.partial`;
}

/** The sha256 sidecar that sits beside a finished dump. */
export function checksumFileName(finalName: string): string {
  return `${finalName}.sha256`;
}

/**
 * Reads a filename back, or returns `null` for anything that is not one of ours.
 *
 * `null` rather than a throw, because this runs over whatever happens to be in
 * the backup directory — an operator's notes, a half-copied file from a USB
 * drive, a `.sha256` sidecar — and none of that is an error. It is simply not a
 * backup, so retention will not count it and will not delete it.
 */
export function parseBackupFileName(name: string): ParsedBackupName | null {
  if (!name.startsWith(PREFIX) || !name.endsWith(EXTENSION)) return null;

  const middle = name.slice(PREFIX.length, name.length - EXTENSION.length);
  const separator = middle.indexOf('-');
  const stamp = separator === -1 ? middle : middle.slice(0, separator);
  const tag = separator === -1 ? null : middle.slice(separator + 1);

  if (!STAMP_PATTERN.test(stamp)) return null;
  if (tag !== null && !TAG_PATTERN.test(tag)) return null;

  const takenAt = stampToDate(stamp);
  if (takenAt === null) return null;

  return { name, stamp, tag, takenAt };
}

function stampToDate(stamp: string): Date | null {
  const iso =
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T` +
    `${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The name a restore renames the live database to before replacing it.
 *
 * Same stamp, same reason: it sorts, it is unambiguous, and nothing about it
 * depends on a timezone. A database name cannot contain a `-` without quoting,
 * so this uses underscores.
 */
export function preRestoreDatabaseName(stamp: string): string {
  return `ekon_pre_restore_${stamp}`;
}

/** True for a name this tool could have produced for a displaced database. */
export function isPreRestoreDatabaseName(name: string): boolean {
  return /^ekon_pre_restore_\d{8}T\d{6}Z$/.test(name);
}
