import pg from 'pg';
import { withDatabase } from './pgTools.js';

/**
 * Cluster-level operations: creating, dropping, and renaming databases.
 *
 * `CREATE DATABASE` and friends cannot run inside a transaction and cannot run
 * against the database they are operating on, so every one of them needs a
 * connection to a *different* database on the same cluster. `postgres` is the
 * maintenance database every PostgreSQL installation has, and is what this
 * connects to.
 *
 * A plain `pg.Client` rather than the application's pool, deliberately. The
 * pool sets `statement_timeout: 15_000` to protect request handling from a
 * runaway query — which is right for a shop at the counter and wrong for a
 * restore of a year of movements, where fifteen seconds is not a runaway, it is
 * Tuesday.
 *
 * These are the sharpest tools in the product. Every one of them takes a
 * database *name* rather than a connection string, and quotes it, so a name can
 * never become a second statement.
 */

/** The database that is connected to in order to act on another one. */
export const MAINTENANCE_DATABASE = 'postgres';

/**
 * A PostgreSQL identifier, quoted.
 *
 * Every database name in this file goes through it, including the ones that
 * came from configuration this process itself wrote. Nothing here interpolates
 * a bare name into SQL, and the moment one did, the exception would be the one
 * nobody reviewed.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Runs `work` against the cluster's maintenance database, and always closes the
 * connection.
 */
export async function withAdminClient<T>(
  databaseUrl: string,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    connectionString: withDatabase(databaseUrl, MAINTENANCE_DATABASE),
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** Runs `work` against one named database on the same cluster. */
export async function withDatabaseClient<T>(
  databaseUrl: string,
  database: string,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: withDatabase(databaseUrl, database) });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export async function databaseExists(client: pg.Client, name: string): Promise<boolean> {
  const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  return rows.length > 0;
}

/**
 * Closes every other connection to a database.
 *
 * `DROP DATABASE` and `ALTER DATABASE … RENAME TO` both fail while anything is
 * connected, and on an installation something always is: the Ekon service
 * itself, holding a pool. Stopping the service first is the right thing and the
 * runbook says so — this is what makes the command work anyway rather than
 * failing with a message an operator has to interpret at the worst moment.
 *
 * `pid <> pg_backend_pid()` keeps it from terminating this very session.
 */
export async function terminateConnections(client: pg.Client, database: string): Promise<number> {
  const { rows } = await client.query<{ pid: number }>(
    `SELECT pg_terminate_backend(pid) AS pid
       FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [database],
  );
  return rows.length;
}

export async function dropDatabaseIfExists(client: pg.Client, name: string): Promise<void> {
  await terminateConnections(client, name);
  await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
}

export async function createDatabase(client: pg.Client, name: string): Promise<void> {
  await client.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
}

export async function renameDatabase(client: pg.Client, from: string, to: string): Promise<void> {
  await terminateConnections(client, from);
  await client.query(`ALTER DATABASE ${quoteIdentifier(from)} RENAME TO ${quoteIdentifier(to)}`);
}
