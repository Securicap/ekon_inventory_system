import { z } from 'zod';

/**
 * What the installation says about itself.
 *
 * Ekon Local runs on a computer in a shop with nobody on site who administers
 * anything (ADR 13). There is no dashboard, no monitoring agent, and no
 * provider taking snapshots — so the questions an operator would otherwise ask
 * infrastructure have to be answerable from inside the application: which build
 * is this, which schema is it on, which profile is it running under, and did a
 * backup actually finish.
 *
 * Deliberately five facts and no metrics. There is no CPU figure, no memory
 * figure, no connection count, and no uptime: none of those is actionable by
 * the owner of a shop, and each would invite a screen that watches numbers
 * instead of answering the one question that matters, which is whether the
 * records would survive losing the computer.
 */

/**
 * The last backup this installation finished, as the backup command recorded
 * it.
 *
 * `ok: false` is a *result*, not an absence — a backup that ran and failed is
 * the most important thing this endpoint can report, and modelling it as "no
 * backup" would hide the failure behind the same answer a fresh installation
 * gives. The error text is deliberately not carried to the client: it comes
 * from a database tool, it is English, and a shop cannot act on it. It stays in
 * `last-backup.json` and in the diagnostics bundle, where support reads it.
 */
export const lastBackupSchema = z
  .object({
    /** When the backup finished, successful or not. ISO 8601, UTC. */
    finishedAt: z.string().datetime(),
    ok: z.boolean(),
    /**
     * The dump's filename, never its full path. A path would put the
     * installation's directory layout on a screen and tell a caller where the
     * business's records are kept, which answers no question the screen asks.
     * `null` when the run failed before a file was finished.
     */
    file: z.string().nullable(),
  })
  .strict();

export type LastBackup = z.infer<typeof lastBackupSchema>;

/** The deployment profile the process was configured with. */
export const deploymentProfileSchema = z.enum(['development', 'hosted', 'local']);

export type DeploymentProfile = z.infer<typeof deploymentProfileSchema>;

/**
 * `GET /api/system/status`, behind `system.manage`.
 *
 * Every field is a fact the server already holds; nothing here is computed from
 * business rows, and no count of products, movements, or users appears. The
 * capability is what keeps the shape of the installation off a counter screen.
 */
export const systemStatusResponseSchema = z
  .object({
    /** The running build, as `/api/health` reports it. */
    appVersion: z.string(),
    /**
     * The migration the database is actually at — read from the database, not
     * from what this build expected. `null` on a database with no migrations
     * applied, which a running application should never see.
     */
    schemaVersion: z.string().nullable(),
    profile: deploymentProfileSchema,
    lastBackup: lastBackupSchema.nullable(),
    /**
     * Free space where backups are written, or `null` when no backup directory
     * is configured or the filesystem could not be read.
     *
     * A dump that runs out of disk is the failure mode this endpoint exists to
     * catch before it happens: it is silent, it happens at three in the
     * morning, and the first sign of it is a restore that has nothing to
     * restore from.
     */
    backupDirFreeBytes: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type SystemStatusResponse = z.infer<typeof systemStatusResponseSchema>;
