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
  // Text nodes of three or more letters that are not an interpolation.
  const textNode = />\s*([A-Za-z][A-Za-z' ]{3,})\s*</g;

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

await checkNoFloatColumns();
await checkLedgerIsAppendOnly();
await checkMigrationNaming();
await checkNoHardcodedStrings();

if (failures.length > 0) {
  console.error('\nConvention check failed:\n');
  for (const { rule, file, detail } of failures) {
    console.error(`  [${rule}] ${file}\n      ${detail}\n`);
  }
  console.error(`${failures.length} problem(s).\n`);
  process.exit(1);
}

console.log('Convention checks passed.');
