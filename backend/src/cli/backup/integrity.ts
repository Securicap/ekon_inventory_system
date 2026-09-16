import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Proving a dump is what it claims to be, before anybody depends on it.
 *
 * Two checks, and they answer different questions.
 *
 * **The magic bytes** say the file is a PostgreSQL custom-format archive at all.
 * The failure this catches is mundane and common: a shell error message, an
 * authentication failure, or an empty file where a dump should be. Discovering
 * that during a restore, six months later, is the difference between a bad
 * night and a closed business.
 *
 * **The sha256** says the bytes have not changed since the backup was taken.
 * That is the check that survives a copy to a USB drive, a year in a drawer,
 * and a copy back — which is the actual journey ADR 13 requires of the off-site
 * copy, and the one nobody watches.
 *
 * The sidecar is written in `sha256sum` format, so an operator with no Ekon
 * tooling — on any machine, in any shell — can run
 * `sha256sum --check ekon-….dump.sha256` and get the same answer. A bespoke
 * format would have made verification depend on the software whose output is
 * being verified.
 */

/** Every PostgreSQL custom-format archive begins with these five bytes. */
export const CUSTOM_FORMAT_MAGIC = 'PGDMP';

/** `<hex>  <filename>\n` — exactly what `sha256sum` writes. */
export function checksumSidecarContent(hex: string, fileName: string): string {
  return `${hex}  ${fileName}\n`;
}

/**
 * The hash out of a `sha256sum`-format sidecar, or `null` if it does not hold
 * one.
 *
 * Only the first line is read and only the hash is taken from it: the filename
 * beside it is the name the file had when it was written, and a backup that was
 * copied onto a drive under a different name is still the same bytes. The hash
 * is the claim; the name is a convenience.
 */
export function parseChecksumSidecar(content: string): string | null {
  const firstLine = content.split('\n', 1)[0] ?? '';
  const match = /^([0-9a-fA-F]{64})\s/.exec(firstLine);
  return match?.[1]?.toLowerCase() ?? null;
}

/** The sha256 of a file, streamed — a dump does not have to fit in memory. */
export async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** True when the file starts with `PGDMP`. */
export async function hasCustomFormatMagic(filePath: string): Promise<boolean> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(CUSTOM_FORMAT_MAGIC.length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead === buffer.length && buffer.toString('latin1') === CUSTOM_FORMAT_MAGIC;
  } finally {
    await handle.close();
  }
}

export interface VerifiedBackup {
  /** The sha256 that was computed over the file as it is now. */
  sha256: string;
  /** Whether a sidecar was found and matched. */
  checksumVerified: boolean;
}

/**
 * Refuses to go any further with a file that is not an intact archive.
 *
 * A **missing** sidecar is reported and does not stop the caller: the magic
 * bytes still prove the file is an archive, and refusing outright would mean an
 * operator holding the only surviving copy of the records could not restore it
 * because a small text file was lost. A sidecar that **exists and disagrees**
 * is fatal — that is corruption, and restoring corruption on purpose is worse
 * than failing.
 */
export async function verifyBackupFile(filePath: string): Promise<VerifiedBackup> {
  if (!(await hasCustomFormatMagic(filePath))) {
    throw new Error(
      `${filePath} is not a PostgreSQL custom-format archive (it does not begin with ` +
        `"${CUSTOM_FORMAT_MAGIC}"). It is not a backup this tool can restore.`,
    );
  }

  const sha256 = await sha256OfFile(filePath);
  const sidecarPath = `${filePath}.sha256`;

  let sidecar: string;
  try {
    sidecar = await readFile(sidecarPath, 'utf8');
  } catch {
    return { sha256, checksumVerified: false };
  }

  const expected = parseChecksumSidecar(sidecar);
  if (expected === null) {
    throw new Error(
      `${sidecarPath} exists but holds no sha256. Delete it or replace it with the output of ` +
        `"sha256sum ${path.basename(filePath)}".`,
    );
  }

  if (expected !== sha256) {
    throw new Error(
      `${filePath} does not match its checksum. Expected ${expected}, computed ${sha256}. ` +
        'This archive is corrupt — do not restore it. Use another copy.',
    );
  }

  return { sha256, checksumVerified: true };
}
