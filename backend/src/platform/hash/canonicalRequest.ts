import { createHash } from 'node:crypto';

/**
 * The digest an operation id is checked against when a command is retried.
 *
 * An operation id says *which* command this is; the hash says *what* that
 * command was. Together they answer the only two questions a replay raises: is
 * this the same command (return what it produced), or is it a different command
 * wearing the same id (refuse it). That second case is the one this file exists
 * for — a stale browser tab reusing an operation id for a different delivery
 * must not be quietly applied.
 *
 * So the digest has to be stable across everything that is not the command and
 * sensitive to everything that is. It is computed from an explicit canonical
 * form rather than from `JSON.stringify` of a request body, because a JSON body
 * carries several things that are not the command: the order the properties
 * happen to be written in, whitespace, and whichever fields a newer client
 * started sending. A retry that differs in any of those is the same delivery.
 *
 * What must never reach this function is anything the server generated —
 * a movement id, a recorded time, a balance, a chain pointer. Those are the
 * *result* of the command, so hashing one would make every retry differ from
 * the attempt it repeats, and idempotency would fail exactly when it is needed.
 */

/**
 * A value a canonical field may hold.
 *
 * Deliberately flat: no arrays, no nested objects. A command whose hash needs a
 * structure is a command whose canonical form deserves to be decided
 * explicitly, in the workflow that owns it, rather than fudged by a generic
 * serializer here.
 */
export type CanonicalValue = string | number | boolean | null;

/** SHA-256, hex — matching the session-token and migration digests. */
export function canonicalRequestHash(fields: Readonly<Record<string, CanonicalValue>>): string {
  return createHash('sha256').update(canonicalRequestForm(fields), 'utf8').digest('hex');
}

/**
 * The exact bytes that get hashed. Exported so its properties can be tested
 * directly, and so a reviewer can see the encoding rather than infer it from a
 * digest.
 *
 * One `name=type:value` line per field, sorted by field name:
 *
 * ```text
 * actorId=s:0198f0a0-…
 * quantity=n:12
 * workflow=s:inventory.receive
 * ```
 *
 * Sorting is what makes the form independent of the order a caller wrote the
 * object literal in. The type tag is what keeps `"12"` and `12` apart, so a
 * client that starts sending a quantity as a string does not silently hash to
 * the same command. Escaping is what stops two different field sets colliding
 * by containing each other's separators.
 */
export function canonicalRequestForm(fields: Readonly<Record<string, CanonicalValue>>): string {
  return Object.keys(fields)
    .sort()
    .map((name) => `${escape(name)}=${encode(name, fields[name])}`)
    .join('\n');
}

function encode(name: string, value: CanonicalValue | undefined): string {
  if (value === null) return 'z:';
  switch (typeof value) {
    case 'string':
      return `s:${escape(value)}`;
    case 'boolean':
      return `b:${value ? 'true' : 'false'}`;
    case 'number':
      // NaN and the infinities have no canonical decimal form, and neither
      // belongs in a business command. Throwing is right: a digest computed
      // from "NaN" would be perfectly stable and completely meaningless.
      if (!Number.isFinite(value)) {
        throw new TypeError(`Canonical field ${name} is not a finite number`);
      }
      // `String` on a number is locale-independent by specification, so a
      // machine with a comma decimal separator produces the same bytes. The
      // `+ 0` normalizes -0, whose string form is "0" only after arithmetic.
      return `n:${String(value + 0)}`;
    default:
      // Unreachable through the exported types; guarded because a value that
      // silently serialized as "[object Object]" would make two different
      // commands hash alike.
      throw new TypeError(`Canonical field ${name} has unsupported type ${typeof value}`);
  }
}

/**
 * Makes the separators unambiguous: a backslash doubles, a newline becomes
 * `\n`, and an `=` becomes `\e`, so the first unescaped `=` always ends the
 * field name and a newline always ends a field.
 */
function escape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/=/g, '\\e');
}
