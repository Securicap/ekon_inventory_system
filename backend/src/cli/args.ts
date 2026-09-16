/**
 * Argument parsing for `ekon-ctl`, written out rather than imported.
 *
 * The whole surface is seven subcommands, five flags, and one positional
 * argument. A parsing library would be a dependency on the installed product —
 * in a directory that ships to a shop computer and is upgraded by replacing it
 * wholesale — in exchange for about forty lines of code that will never need to
 * do anything else.
 *
 * Deliberately strict, in the one way that matters for a tool that can drop a
 * database: an unknown flag is an error. `--discard-prevous` must not be
 * silently ignored, and neither must `--yess`.
 */

export interface ParsedArgs {
  command: string | undefined;
  /** Everything that is not a flag, in order. */
  positional: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;

    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }

    const equals = argument.indexOf('=');
    if (equals !== -1) {
      flags.set(argument.slice(2, equals), argument.slice(equals + 1));
      continue;
    }

    const name = argument.slice(2);
    const next = argv[index + 1];
    // A flag takes the following token as its value only when that token is not
    // itself a flag. `--yes --discard-previous x` therefore parses as two
    // flags, not as `--yes=--discard-previous`.
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }

  return { command: positional.shift(), positional, flags };
}

/**
 * Rejects any flag the command does not know.
 *
 * The failure this prevents is specific and bad: a misspelt `--yes` on a
 * restore would otherwise be a run that refused for a reason the operator does
 * not expect, and a misspelt `--allow-external` would be a refusal they work
 * around by typing something more dangerous.
 */
export function assertKnownFlags(
  parsed: ParsedArgs,
  command: string,
  known: readonly string[],
): void {
  const unknown = [...parsed.flags.keys()].filter((flag) => !known.includes(flag));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown option(s) for "${command}": ${unknown.map((flag) => `--${flag}`).join(', ')}. ` +
        `Known: ${known.map((flag) => `--${flag}`).join(', ') || '(none)'}.`,
    );
  }
}

/** A flag's value, when it must have one. */
export function flagValue(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  if (value === undefined) return undefined;
  if (value === true) {
    throw new Error(`--${name} needs a value, for example --${name} <value>.`);
  }
  return value;
}

/** True when a flag is present, however it was written. */
export function flagIsSet(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.has(name);
}
