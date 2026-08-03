import { randomInt } from 'node:crypto';

/**
 * Server-generated SKUs.
 *
 * A SKU is `EKN-` followed by eight random characters. It is deliberately
 * *non-semantic*: it encodes nothing about the product name, its attributes, a
 * category, the date, or a database sequence, so it never has to change when any
 * of those do, and it ends up printed on a physical shelf label unchanged.
 *
 * The alphabet omits the visually ambiguous characters `0 O 1 I` so a SKU read
 * off a label and typed back in is not a guessing game.
 */
export const SKU_PREFIX = 'EKN-';
export const SKU_SUFFIX_LENGTH = 8;
export const SKU_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Generates one candidate SKU. Uniqueness is enforced by the database. */
export function generateSku(): string {
  let suffix = '';
  for (let i = 0; i < SKU_SUFFIX_LENGTH; i += 1) {
    // randomInt is uniform over [0, n) and drawn from a CSPRNG, so the suffix
    // is unbiased across the alphabet.
    suffix += SKU_ALPHABET[randomInt(SKU_ALPHABET.length)];
  }
  return `${SKU_PREFIX}${suffix}`;
}
