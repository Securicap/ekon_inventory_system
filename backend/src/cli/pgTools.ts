import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * Running `pg_dump` and `pg_restore` — the two things this product cannot do
 * for itself.
 *
 * **Which binary.** `EKON_PG_BIN` names the directory of the PostgreSQL the
 * installation bundles, and it exists because version matters more than
 * convenience: `pg_dump` refuses to dump a server newer than itself, and an
 * archive written by a newer `pg_dump` may not restore into an older server. A
 * shop computer can easily end up with some other PostgreSQL's tools first on
 * `PATH` — a client left by another application, a stale install — and the
 * failure that produces arrives at 3am, in a scheduled backup nobody is
 * watching. Unset means "whatever is on `PATH`", which is what a developer's
 * machine wants.
 *
 * **How credentials are passed.** Never on the command line. `ps` shows every
 * process's arguments to every user on the machine, so a connection URI
 * containing a password would be readable by anyone with a shell there for as
 * long as the dump runs — and a dump runs for a while. The URL is decomposed
 * into `PGHOST`/`PGUSER`/`PGPASSWORD`/… in the child's environment instead,
 * which is not world-readable in the same way. It is the same reasoning the
 * create-owner command applies to the owner's password.
 */

export type PgTool = 'pg_dump' | 'pg_restore' | 'psql';

/**
 * The full path to a PostgreSQL binary, or the bare name when the installation
 * has not pinned a directory.
 *
 * `.exe` is not appended on Windows: `spawn` resolves it through the same rules
 * the shell would, and hard-coding the extension would break the case where an
 * operator points `EKON_PG_BIN` at a directory of shims.
 */
export function resolvePgBinary(tool: PgTool, pgBin?: string | undefined): string {
  const directory = pgBin?.trim();
  return directory === undefined || directory === '' ? tool : path.join(directory, tool);
}

/**
 * The connection, as environment variables a `libpq` tool understands.
 *
 * Decomposed rather than passed as a URI so the password never becomes an
 * argument. A URL with no password yields no `PGPASSWORD`, which leaves the
 * child to `.pgpass`, peer authentication, or whatever else it would normally
 * use — a local installation on Windows authenticates with a password, and a
 * developer on a Unix socket may not.
 */
export function pgEnvFromUrl(databaseUrl: string): NodeJS.ProcessEnv {
  const url = new URL(databaseUrl);
  const env: NodeJS.ProcessEnv = {};

  if (url.hostname) env.PGHOST = decodeURIComponent(url.hostname);
  if (url.port) env.PGPORT = url.port;
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);

  const database = url.pathname.replace(/^\//, '');
  if (database) env.PGDATABASE = decodeURIComponent(database);

  // `sslmode` and anything else libpq understands travels as a query parameter.
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;

  return env;
}

/** The database a connection string names, for a caller that has to say it. */
export function databaseNameFromUrl(databaseUrl: string): string {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  if (name === '') {
    throw new Error(`DATABASE_URL names no database: ${redactUrl(databaseUrl)}`);
  }
  return name;
}

/** The same connection string, pointed at a different database on the cluster. */
export function withDatabase(databaseUrl: string, database: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

/**
 * A connection string with its password removed, for anything that might be
 * printed or written to a diagnostics bundle.
 */
export function redactUrl(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '<unparseable DATABASE_URL>';
  }
}

export interface RunPgToolOptions {
  databaseUrl: string;
  pgBin?: string | undefined;
  /** Where the tool's own output goes, line by line. */
  log?: ((message: string) => void) | undefined;
}

/**
 * Runs a PostgreSQL tool to completion and throws unless it exits 0.
 *
 * `stderr` is captured and put in the error, because that is where these tools
 * say what went wrong and an exit code on its own is not something an operator
 * can act on. It is also echoed as it arrives: a restore of a large database
 * that printed nothing for ten minutes would look like a hang.
 *
 * `shell: false` — the arguments are passed as an array and never interpolated
 * into a command line, so a database name or a path containing a space, a
 * quote, or a semicolon is an argument and not a second command.
 */
export async function runPgTool(
  tool: PgTool,
  args: readonly string[],
  options: RunPgToolOptions,
): Promise<void> {
  const binary = resolvePgBinary(tool, options.pgBin);
  const log = options.log ?? ((): void => {});

  const child = spawn(binary, [...args], {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...pgEnvFromUrl(options.databaseUrl),
      // Error messages in English, whatever the shop computer's locale, so they
      // match what the runbook and a support conversation expect.
      LC_ALL: 'C',
    },
  });

  const errorOutput: string[] = [];

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) if (line.trim() !== '') log(`  ${tool}: ${line}`);
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    errorOutput.push(chunk);
    for (const line of chunk.split('\n')) if (line.trim() !== '') log(`  ${tool}: ${line}`);
  });

  const code = await new Promise<number>((resolve, reject) => {
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'ENOENT'
          ? new Error(
              `${binary} was not found. Set EKON_PG_BIN to the directory holding the ` +
                "PostgreSQL client tools of this installation's own server, or put them on PATH.",
            )
          : error,
      );
    });
    child.on('close', (exitCode) => resolve(exitCode ?? 1));
  });

  if (code !== 0) {
    const detail = errorOutput.join('').trim();
    throw new Error(
      `${tool} exited with code ${code}${detail === '' ? '' : `:\n${indent(detail)}`}`,
    );
  }
}

/** The version string a tool reports, for the diagnostics bundle. */
export async function pgToolVersion(
  tool: PgTool,
  pgBin?: string | undefined,
): Promise<string | null> {
  const binary = resolvePgBinary(tool, pgBin);
  return new Promise((resolve) => {
    const child = spawn(binary, ['--version'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? output.trim() : null));
  });
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}
