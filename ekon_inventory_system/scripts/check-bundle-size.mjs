#!/usr/bin/env node
/**
 * The shop is on an unreliable connection in Haiti. Every kilobyte in the
 * initial payload is time the person at the counter spends waiting, so the
 * budget is enforced by the build rather than by good intentions.
 */
import { gzipSync } from 'node:zlib';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const ASSETS = path.join(ROOT, 'backend/public/assets');

const BUDGET_JS_GZIP_KB = 200;
const BUDGET_CSS_GZIP_KB = 30;

async function gzippedKb(file) {
  const content = await readFile(file);
  return gzipSync(content, { level: 9 }).byteLength / 1024;
}

let entries;
try {
  await stat(ASSETS);
  entries = await readdir(ASSETS);
} catch {
  console.error(`No build found at ${path.relative(ROOT, ASSETS)}. Run the frontend build first.`);
  process.exit(1);
}

let js = 0;
let css = 0;
const rows = [];

for (const name of entries) {
  const file = path.join(ASSETS, name);
  if (name.endsWith('.js')) {
    const kb = await gzippedKb(file);
    js += kb;
    rows.push([name, kb]);
  } else if (name.endsWith('.css')) {
    const kb = await gzippedKb(file);
    css += kb;
    rows.push([name, kb]);
  }
}

for (const [name, kb] of rows.sort((a, b) => b[1] - a[1])) {
  console.log(`  ${kb.toFixed(1).padStart(7)} KB gz  ${name}`);
}
console.log(`\n  JS total:  ${js.toFixed(1)} KB gz (budget ${BUDGET_JS_GZIP_KB} KB)`);
console.log(`  CSS total: ${css.toFixed(1)} KB gz (budget ${BUDGET_CSS_GZIP_KB} KB)\n`);

const problems = [];
if (js > BUDGET_JS_GZIP_KB) problems.push(`JS is ${js.toFixed(1)} KB gz, over the budget`);
if (css > BUDGET_CSS_GZIP_KB) problems.push(`CSS is ${css.toFixed(1)} KB gz, over the budget`);

if (problems.length > 0) {
  console.error('Bundle budget exceeded:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\nEither remove a dependency or raise the budget deliberately, in a PR.\n');
  process.exit(1);
}

console.log('Bundle budget OK.');
