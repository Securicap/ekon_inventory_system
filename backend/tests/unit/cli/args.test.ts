import { describe, expect, it } from 'vitest';
import { assertKnownFlags, flagIsSet, flagValue, parseArgs } from '../../../src/cli/args.js';

/**
 * `ekon-ctl` can drop a database. The parser is strict for one reason: a
 * misspelt `--yes` must be an error, not a refusal the operator works around by
 * typing something more dangerous.
 */

describe('parseArgs', () => {
  it('reads a command and its positional argument', () => {
    const parsed = parseArgs(['restore', '/srv/ekon/backups/ekon-x.dump']);
    expect(parsed.command).toBe('restore');
    expect(parsed.positional).toEqual(['/srv/ekon/backups/ekon-x.dump']);
  });

  it('reads a flag with a value, written either way', () => {
    expect(flagValue(parseArgs(['backup', '--tag', 'monthly']), 'tag')).toBe('monthly');
    expect(flagValue(parseArgs(['backup', '--tag=monthly']), 'tag')).toBe('monthly');
  });

  it('reads a bare flag as present', () => {
    const parsed = parseArgs(['restore', 'x.dump', '--yes']);
    expect(flagIsSet(parsed, 'yes')).toBe(true);
    expect(flagIsSet(parsed, 'allow-external')).toBe(false);
  });

  it('does not swallow the next flag as a value', () => {
    // `--yes --discard-previous x` is two flags, not --yes=--discard-previous.
    const parsed = parseArgs(['restore', 'x.dump', '--yes', '--discard-previous', 'ekon_pre']);
    expect(flagIsSet(parsed, 'yes')).toBe(true);
    expect(flagValue(parsed, 'discard-previous')).toBe('ekon_pre');
  });

  it('refuses to guess at a flag that needs a value and has none', () => {
    expect(() => flagValue(parseArgs(['backup', '--tag']), 'tag')).toThrow(/needs a value/);
  });

  it('has no flags and no command for an empty command line', () => {
    const parsed = parseArgs([]);
    expect(parsed.command).toBeUndefined();
    expect(parsed.flags.size).toBe(0);
  });
});

describe('assertKnownFlags', () => {
  it('accepts what the command declares', () => {
    const parsed = parseArgs(['restore', 'x.dump', '--yes']);
    expect(() => assertKnownFlags(parsed, 'restore', ['yes', 'allow-external'])).not.toThrow();
  });

  it('refuses a misspelt flag rather than ignoring it', () => {
    // The failure this prevents: `--yess` on a restore would otherwise be a run
    // that refused for a reason the operator does not expect.
    const parsed = parseArgs(['restore', 'x.dump', '--yess']);
    expect(() => assertKnownFlags(parsed, 'restore', ['yes'])).toThrow(/--yess/);
  });

  it('names every unknown flag at once, and what was allowed', () => {
    const parsed = parseArgs(['backup', '--tagg', 'x', '--force']);
    expect(() => assertKnownFlags(parsed, 'backup', ['tag'])).toThrow(
      /--tagg, --force[\s\S]*Known: --tag/,
    );
  });

  it('refuses any flag at all on a command that takes none', () => {
    const parsed = parseArgs(['migrate', '--force']);
    expect(() => assertKnownFlags(parsed, 'migrate', [])).toThrow(/--force/);
  });
});
