import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checksumSidecarContent,
  CUSTOM_FORMAT_MAGIC,
  hasCustomFormatMagic,
  parseChecksumSidecar,
  sha256OfFile,
  verifyBackupFile,
} from '../../../src/cli/backup/integrity.js';

/**
 * An untested backup is not a backup, and the two cheap tests are the magic
 * bytes and the checksum. Between them they catch the shell error that landed
 * in a file instead of a dump, and the bit rot that a year in a drawer and two
 * copies onto a USB drive produce.
 */

let directory: string;

/** A file that looks exactly as much like a dump as it is told to. */
function write(name: string, contents: string | Buffer): string {
  const target = path.join(directory, name);
  writeFileSync(target, contents);
  return target;
}

const dumpBytes = Buffer.concat([Buffer.from(CUSTOM_FORMAT_MAGIC), Buffer.from([1, 2, 3, 4])]);

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'ekon-integrity-'));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('the sidecar', () => {
  it('is written in the format sha256sum reads', () => {
    // So an operator on any machine, with no Ekon tooling, can verify a backup
    // with `sha256sum --check`. A bespoke format would make verification depend
    // on the software being verified.
    expect(checksumSidecarContent('abc123', 'ekon-x.dump')).toBe('abc123  ekon-x.dump\n');
  });

  it('is read back for its hash, and not for the name beside it', () => {
    // A backup copied onto a drive under another name is the same bytes.
    const hex = 'a'.repeat(64);
    expect(parseChecksumSidecar(`${hex}  ekon-x.dump\n`)).toBe(hex);
    expect(parseChecksumSidecar(`${hex.toUpperCase()}  whatever\n`)).toBe(hex);
    expect(parseChecksumSidecar(`${hex} *ekon-x.dump\n`)).toBe(hex);
  });

  it('is not a hash when it does not hold one', () => {
    expect(parseChecksumSidecar('')).toBeNull();
    expect(parseChecksumSidecar('not a checksum\n')).toBeNull();
    expect(parseChecksumSidecar('abc  ekon-x.dump\n')).toBeNull();
  });
});

describe('hasCustomFormatMagic', () => {
  it('recognizes a PostgreSQL custom-format archive', async () => {
    expect(await hasCustomFormatMagic(write('good.dump', dumpBytes))).toBe(true);
  });

  it('refuses the shell error message that landed in the file instead', async () => {
    expect(
      await hasCustomFormatMagic(write('error.dump', 'pg_dump: error: connection failed\n')),
    ).toBe(false);
  });

  it('refuses an empty file, and one too short to hold the magic', async () => {
    expect(await hasCustomFormatMagic(write('empty.dump', ''))).toBe(false);
    expect(await hasCustomFormatMagic(write('tiny.dump', 'PGD'))).toBe(false);
  });
});

describe('verifyBackupFile', () => {
  it('passes a dump whose sidecar matches', async () => {
    const file = write('verified.dump', dumpBytes);
    const hash = await sha256OfFile(file);
    write('verified.dump.sha256', checksumSidecarContent(hash, 'verified.dump'));

    const result = await verifyBackupFile(file);
    expect(result.checksumVerified).toBe(true);
    expect(result.sha256).toBe(hash);
  });

  it('refuses a dump whose sidecar disagrees, and says not to restore it', async () => {
    const file = write('corrupt.dump', dumpBytes);
    write('corrupt.dump.sha256', checksumSidecarContent('b'.repeat(64), 'corrupt.dump'));

    await expect(verifyBackupFile(file)).rejects.toThrow(/corrupt — do not restore it/);
  });

  it('refuses a file that is not an archive at all, before hashing anything', async () => {
    const file = write('nonsense.dump', 'this is not a dump');
    await expect(verifyBackupFile(file)).rejects.toThrow(/not a PostgreSQL custom-format archive/);
  });

  it('continues without a sidecar, and says the integrity is unproven', async () => {
    // Refusing outright would mean an operator holding the only surviving copy
    // of the records could not restore it because a small text file was lost.
    const file = write('no-sidecar.dump', dumpBytes);
    const result = await verifyBackupFile(file);
    expect(result.checksumVerified).toBe(false);
    expect(result.sha256).toHaveLength(64);
  });

  it('refuses a sidecar that exists and holds nothing usable', async () => {
    const file = write('junk-sidecar.dump', dumpBytes);
    write('junk-sidecar.dump.sha256', 'I checked it, it was fine\n');
    await expect(verifyBackupFile(file)).rejects.toThrow(/holds no sha256/);
  });
});
