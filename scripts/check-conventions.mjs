#!/usr/bin/env node
/**
 * Conventions that a linter cannot express, checked mechanically in CI.
 *
 * Each rule here corresponds to a decision that is expensive or impossible to
 * reverse once real inventory exists. A code review can miss one of these; a
 * build should not.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const failures = [];

function fail(rule, file, detail) {
  failures.push({ rule, file, detail });
}

async function walk(dir, predicate, found = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'public') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, predicate, found);
    else if (predicate(full)) found.push(full);
  }
  return found;
}

/**
 * Rule 1 — no floating-point columns in migrations.
 *
 * A float quantity in an inventory ledger is an unfixable defect once history
 * exists. Quantities are integers in base units; money is bigint minor units.
 */
async function checkNoFloatColumns() {
  const files = await walk(path.join(ROOT, 'backend/migrations'), (f) => f.endsWith('.sql'));
  const banned = /\b(real|double\s+precision|float4|float8|money)\b/gi;

  for (const file of files) {
    const sql = await readFile(file, 'utf8');
    const withoutComments = sql.replace(/--.*$/gm, '');
    const matches = withoutComments.match(banned);
    if (matches) {
      fail(
        'no-float-columns',
        path.relative(ROOT, file),
        `found ${[...new Set(matches.map((m) => m.toLowerCase()))].join(', ')} — ` +
          'quantities are integer base units, money is bigint minor units',
      );
    }
  }
}

/**
 * Rule 2 — the movement ledger is append-only in code as well as in the database.
 *
 * The database enforces this with triggers and a restricted role. This check
 * catches the intent earlier, in review, with a clearer message.
 */
async function checkLedgerIsAppendOnly() {
  const files = await walk(
    path.join(ROOT, 'backend/src'),
    (f) => f.endsWith('.ts') && !f.endsWith('.d.ts'),
  );
  const banned = [
    /update\s+inventory_movements/i,
    /delete\s+from\s+inventory_movements/i,
    /truncate\s+.*inventory_movements/i,
  ];

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const pattern of banned) {
      if (pattern.test(source)) {
        fail(
          'append-only-ledger',
          path.relative(ROOT, file),
          'inventory_movements may only be INSERTed into or SELECTed from. ' +
            'Corrections are compensating movements, never edits.',
        );
      }
    }
  }
}

/**
 * Rule 3 — migrations are immutable once merged, and correctly named.
 */
async function checkMigrationNaming() {
  const dir = path.join(ROOT, 'backend/migrations');
  const files = (await walk(dir, (f) => f.endsWith('.sql'))).map((f) => path.basename(f)).sort();
  const pattern = /^(\d{4})_[a-z0-9_]+\.sql$/;
  const seen = new Set();

  for (const name of files) {
    const match = pattern.exec(name);
    if (!match) {
      fail('migration-naming', `backend/migrations/${name}`, 'expected NNNN_lower_snake_case.sql');
      continue;
    }
    if (seen.has(match[1])) {
      fail('migration-naming', `backend/migrations/${name}`, `duplicate version ${match[1]}`);
    }
    seen.add(match[1]);
  }
}

/**
 * Rule 4 — no hard-coded user-facing strings in components.
 *
 * Employees use this in Haitian Creole. A string baked into JSX is a string
 * that will never be translated.
 */
async function checkNoHardcodedStrings() {
  const files = await walk(path.join(ROOT, 'frontend/src'), (f) => f.endsWith('.tsx'));
  // A JSX text node: letters between a closing `>` and the next `<`. The letter
  // class is Unicode (`\p{L}`), so accented French and Haitian Creole — "Lè",
  // "Non", "Èske sa bon" — are caught, not just ASCII.
  //
  // False positives inside TypeScript expressions are avoided two ways: the run
  // must start with a letter (a `{expr}` interpolation starts with `{`), and the
  // negative lookbehind `(?<!=)` skips the `>` of an arrow function `=>`.
  const textNode = /(?<!=)>\s*(\p{L}[\p{L}'’ ]*\p{L})\s*</gu;

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    let match;
    while ((match = textNode.exec(source)) !== null) {
      const text = match[1].trim();
      fail(
        'no-hardcoded-strings',
        path.relative(ROOT, file),
        `literal text "${text}" — use t('some.key') and add it to both locale files`,
      );
    }
  }
}

/**
 * Rule 5 — the two locale catalogues describe the same application.
 *
 * Every screen was translated by the PR that built it, and a key added to one
 * catalogue and forgotten in the other is invisible until somebody reads the
 * interface in the language it is missing from — at which point they get the
 * other language, or a raw key. The placeholders have to match too: a message
 * that interpolates `{count}` in Creole and nothing in French silently drops
 * the number.
 */
async function checkLocaleParity() {
  const dir = path.join(ROOT, 'frontend/src/i18n');
  const [primary, secondary] = await Promise.all([
    readFile(path.join(dir, 'ht.json'), 'utf8').then(JSON.parse),
    readFile(path.join(dir, 'fr.json'), 'utf8').then(JSON.parse),
  ]);

  const placeholders = (value) =>
    [...String(value).matchAll(/\{(\w+)\}/g)]
      .map((m) => m[1])
      .sort()
      .join(',');

  for (const key of Object.keys(primary)) {
    if (!(key in secondary)) {
      fail('locale-parity', 'frontend/src/i18n/fr.json', `missing "${key}"`);
    } else if (placeholders(primary[key]) !== placeholders(secondary[key])) {
      fail(
        'locale-parity',
        'frontend/src/i18n/fr.json',
        `"${key}" interpolates {${placeholders(primary[key])}} in ht and ` +
          `{${placeholders(secondary[key])}} in fr`,
      );
    }
  }

  for (const key of Object.keys(secondary)) {
    if (!(key in primary)) {
      fail('locale-parity', 'frontend/src/i18n/ht.json', `missing "${key}"`);
    }
  }
}

/**
 * Rule 6 — a region that takes focus by code draws a ring when it does.
 *
 * Every screen that reports an outcome moves focus to it, so somebody on a
 * keyboard lands on the answer. `focus-visible` is a heuristic about how focus
 * arrived and does not reliably fire for a scripted `.focus()` on a
 * `tabIndex={-1}` container, so those regions need the plain `:focus` ring that
 * `OUTCOME_FOCUS` carries. Four of the five screens shipped without it.
 */
async function checkProgrammaticFocusIsVisible() {
  const files = await walk(path.join(ROOT, 'frontend/src'), (f) => f.endsWith('.tsx'));

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const targets = source.match(/tabIndex=\{-1\}/g)?.length ?? 0;
    if (targets === 0) continue;

    // The import specifier sits on its own line; only uses count.
    const uses =
      source.replace(/^\s*OUTCOME_FOCUS,\s*$/gm, '').match(/OUTCOME_FOCUS/g)?.length ?? 0;
    if (uses < targets) {
      fail(
        'programmatic-focus-visible',
        path.relative(ROOT, file),
        `${targets} element(s) with tabIndex={-1} but ${uses} use(s) of OUTCOME_FOCUS — ` +
          'a region focused by code must draw a ring',
      );
    }
  }
}

await checkNoFloatColumns();
await checkLedgerIsAppendOnly();
await checkMigrationNaming();
await checkNoHardcodedStrings();
await checkLocaleParity();
await checkProgrammaticFocusIsVisible();

if (failures.length > 0) {
  console.error('\nConvention check failed:\n');
  for (const { rule, file, detail } of failures) {
    console.error(`  [${rule}] ${file}\n      ${detail}\n`);
  }
  console.error(`${failures.length} problem(s).\n`);
  process.exit(1);
}

console.log('Convention checks passed.');
