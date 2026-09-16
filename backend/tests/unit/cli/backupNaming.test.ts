import { describe, expect, it } from 'vitest';
import {
  assertUsableTag,
  backupFileName,
  backupStamp,
  checksumFileName,
  isPreRestoreDatabaseName,
  parseBackupFileName,
  partialFileName,
  preRestoreDatabaseName,
} from '../../../src/cli/backup/naming.js';

/**
 * A backup's name is how it is ordered, how retention groups it, and how an
 * operator reads a directory listing. It is data, and it is tested as data.
 */

describe('backupStamp', () => {
  it('is UTC, basic ISO, and sorts chronologically as text', () => {
    expect(backupStamp(new Date('2026-09-15T03:15:00.000Z'))).toBe('20260915T031500Z');
    expect(backupStamp(new Date('2026-09-15T03:15:00.999Z'))).toBe('20260915T031500Z');

    const earlier = backupStamp(new Date('2026-09-14T23:59:59Z'));
    const later = backupStamp(new Date('2026-09-15T00:00:00Z'));
    expect(earlier < later).toBe(true);
  });

  it('has no colon in it, because Windows filenames may not', () => {
    expect(backupStamp(new Date('2026-09-15T03:15:00Z'))).not.toContain(':');
  });
});

describe('backupFileName', () => {
  it('names an ordinary backup', () => {
    expect(backupFileName('20260915T031500Z')).toBe('ekon-20260915T031500Z.dump');
  });

  it('carries a tag when one was given', () => {
    expect(backupFileName('20260915T031500Z', 'before-upgrade')).toBe(
      'ekon-20260915T031500Z-before-upgrade.dump',
    );
  });

  it('treats an empty tag as no tag', () => {
    expect(backupFileName('20260915T031500Z', '')).toBe('ekon-20260915T031500Z.dump');
    expect(backupFileName('20260915T031500Z', null)).toBe('ekon-20260915T031500Z.dump');
  });

  it('keeps a partial dump out of the way of every glob that matters', () => {
    const name = backupFileName('20260915T031500Z');
    const partial = partialFileName(name);
    expect(partial).toBe('.ekon-20260915T031500Z.dump.partial');
    // A crashed run must never leave something a restore or a prune can find.
    expect(parseBackupFileName(partial)).toBeNull();
  });

  it('puts the checksum beside the dump under the name sha256sum expects', () => {
    expect(checksumFileName('ekon-20260915T031500Z.dump')).toBe(
      'ekon-20260915T031500Z.dump.sha256',
    );
  });
});

describe('assertUsableTag', () => {
  it('accepts a short label', () => {
    for (const tag of ['before-upgrade', 'monthly', 'v2_0', 'A1']) {
      expect(() => assertUsableTag(tag)).not.toThrow();
    }
  });

  it('refuses anything that could climb out of the backup directory', () => {
    // A tag ends up in a filename, and a tagged backup is never pruned — so it
    // is deliberately not free text.
    for (const tag of ['../etc', 'a/b', 'a\\b', 'a.dump', 'has space', '', '-leading']) {
      expect(() => assertUsableTag(tag), tag).toThrow(/not usable in a filename/);
    }
  });

  it('refuses a sentence', () => {
    expect(() => assertUsableTag('x'.repeat(33))).toThrow();
  });
});

describe('parseBackupFileName', () => {
  it('reads a stamp back as an instant', () => {
    const parsed = parseBackupFileName('ekon-20260915T031500Z.dump');
    expect(parsed?.stamp).toBe('20260915T031500Z');
    expect(parsed?.tag).toBeNull();
    expect(parsed?.takenAt.toISOString()).toBe('2026-09-15T03:15:00.000Z');
  });

  it('reads a tag, including one containing hyphens', () => {
    const parsed = parseBackupFileName('ekon-20260915T031500Z-before-the-upgrade.dump');
    expect(parsed?.tag).toBe('before-the-upgrade');
    expect(parsed?.stamp).toBe('20260915T031500Z');
  });

  it('returns null for everything that is not one of ours', () => {
    // The backup directory holds whatever an operator put there — notes, a
    // half-copied file from a drive, the sidecars. None of that is an error,
    // and none of it may be counted or deleted by retention.
    for (const name of [
      'ekon-20260915T031500Z.dump.sha256',
      'notes.txt',
      'ekon-2026.dump',
      'ekon-20260915T031500.dump',
      'ekon-.dump',
      'backup.dump',
      'ekon-20261332T031500Z.dump',
    ]) {
      expect(parseBackupFileName(name), name).toBeNull();
    }
  });
});

describe('the database a restore displaces', () => {
  it('is named from the same stamp, with no hyphen a bare identifier could not hold', () => {
    expect(preRestoreDatabaseName('20260915T031500Z')).toBe('ekon_pre_restore_20260915T031500Z');
  });

  it('recognizes only names this tool could have produced', () => {
    expect(isPreRestoreDatabaseName('ekon_pre_restore_20260915T031500Z')).toBe(true);
    // Everything a mistyped --discard-previous could otherwise reach.
    expect(isPreRestoreDatabaseName('ekon')).toBe(false);
    expect(isPreRestoreDatabaseName('postgres')).toBe(false);
    expect(isPreRestoreDatabaseName('ekon_pre_restore_')).toBe(false);
    expect(isPreRestoreDatabaseName('ekon_pre_restore_x"; DROP DATABASE ekon; --')).toBe(false);
  });
});
