import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { lastBackupSchema, type LastBackup } from '@ekon/shared';
import { z } from 'zod';

/**
 * What the installation remembers about its own last backup.
 *
 * One small JSON file in the state directory, written by the backup command and
 * read by `GET /api/system/status`. It is how an owner finds out that backups
 * have been failing, on a machine with no monitoring, no email, and nobody on
 * site who would read a log.
 *
 * **A failure is written as loudly as a success.** `ok: false` with the error
 * is the entire point: a backup command that failed and left no record would be
 * indistinguishable from one that never ran, and both would read on the status
 * screen as "no backup yet" — which is the sentence that gets a shop to shrug.
 *
 * It is a *report*, not a lock and not a queue. Nothing reads it to decide
 * whether to take a backup, so a stale or missing file can never prevent one.
 *
 * It lives in `platform/` because it has two sides that must agree and that are
 * otherwise far apart: `ekon-ctl backup` writes it, and `GET /api/system/status`
 * reads it. Neither owns it, and a second definition of the shape — one in the
 * command and one in the module — is exactly the drift that would leave a
 * status screen reporting a field the backup stopped writing a year ago.
 */

export const LAST_BACKUP_FILE = 'last-backup.json';

/**
 * The stored shape: what the API returns, plus the two things a screen has no
 * use for and support does.
 *
 * `bytes` says whether the dump is a plausible size — a sudden drop to a few
 * kilobytes is a database that lost its data before anybody noticed. `error` is
 * the tool's own message, English and technical, which is why it stays in this
 * file and in the diagnostics bundle and does not travel to a shop screen.
 */
export const storedLastBackupSchema = lastBackupSchema.extend({
  bytes: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
});

export type StoredLastBackup = z.infer<typeof storedLastBackupSchema>;

export function lastBackupPath(stateDir: string): string {
  return path.join(stateDir, LAST_BACKUP_FILE);
}

/**
 * Writes the record, creating the state directory if it is not there.
 *
 * Failing to write it must never turn a successful backup into a failed one —
 * the dump on disk is the thing that matters and it is already there — so the
 * caller treats an error here as its own problem and says so, rather than
 * unwinding a backup that worked.
 */
export async function writeLastBackup(stateDir: string, record: StoredLastBackup): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    lastBackupPath(stateDir),
    `${JSON.stringify(storedLastBackupSchema.parse(record), null, 2)}\n`,
    'utf8',
  );
}

/**
 * Reads the record, or `null` when there is none or it cannot be understood.
 *
 * Deliberately forgiving. This is read by an HTTP request on a screen somebody
 * opened to find out whether their records are safe; a corrupt state file must
 * report "nothing recorded" rather than take the endpoint down, because the
 * rest of what that endpoint says is still true and still useful.
 */
export async function readLastBackup(stateDir: string): Promise<LastBackup | null> {
  let raw: string;
  try {
    raw = await readFile(lastBackupPath(stateDir), 'utf8');
  } catch {
    return null;
  }

  try {
    const parsed = storedLastBackupSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    // Only the three fields the wire shape carries. `bytes` and `error` stay on
    // disk: the first is noise on a screen, the second is a database tool's
    // English and nothing a shop can act on.
    return { finishedAt: parsed.data.finishedAt, ok: parsed.data.ok, file: parsed.data.file };
  } catch {
    return null;
  }
}
