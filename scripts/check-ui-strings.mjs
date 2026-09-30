#!/usr/bin/env node
// Ratchet against hardcoded UI text (#168). The product UI is translated
// screen by screen; this keeps the untranslated count from growing meanwhile.
// Every scanned .tsx file has an allowance in ui-strings-baseline.json: it may
// go down, never up, and a file not in the baseline is allowed none.
//
//   node scripts/check-ui-strings.mjs            check (CI)
//   node scripts/check-ui-strings.mjs --update   shrink the baseline to today's counts

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const BASELINE = join(ROOT, "scripts", "ui-strings-baseline.json");
const SCAN = ["app/(dashboard)", "components"];
// Primitives and demo pages carry no product copy of their own.
const SKIP = ["components/ui/", "app/(dashboard)/design-system/"];

const LETTERS = /[A-Za-zÄÖÜäöüß]{2,}/;
const TEXT_NODE = />([^<>{}]+)</g;
const ATTRIBUTE = /\b(?:placeholder|title|aria-label|alt|label|description)=(["'])(.*?)\1/g;

/** Hardcoded user-facing strings in one TSX source. */
export function countHardcodedStrings(source) {
  let count = 0;
  for (const [, text] of source.matchAll(TEXT_NODE)) {
    if (LETTERS.test(text)) count++;
  }
  for (const [, , value] of source.matchAll(ATTRIBUTE)) {
    if (LETTERS.test(value)) count++;
  }
  return count;
}

/** Files whose count exceeds their allowance. */
export function compareToBaseline(counts, baseline) {
  return Object.entries(counts)
    .filter(([file, count]) => count > (baseline[file] ?? 0))
    .map(([file, count]) => ({ file, count, allowed: baseline[file] ?? 0 }));
}

function* tsxFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* tsxFiles(path);
    else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) yield path;
  }
}

function currentCounts() {
  const counts = {};
  for (const dir of SCAN) {
    for (const path of tsxFiles(join(ROOT, dir))) {
      const file = relative(ROOT, path).split(sep).join("/");
      if (SKIP.some((prefix) => file.startsWith(prefix))) continue;
      const count = countHardcodedStrings(readFileSync(path, "utf8"));
      if (count > 0) counts[file] = count;
    }
  }
  return counts;
}

function main() {
  const counts = currentCounts();
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));

  if (process.argv.includes("--update")) {
    const shrunk = Object.fromEntries(
      Object.entries(counts)
        .filter(([file]) => file in baseline)
        .map(([file, count]) => [file, Math.min(count, baseline[file])])
        .sort(([a], [b]) => a.localeCompare(b))
    );
    writeFileSync(BASELINE, JSON.stringify(shrunk, null, 2) + "\n");
    console.log(`baseline: ${Object.keys(shrunk).length} files`);
    return;
  }

  const over = compareToBaseline(counts, baseline);
  if (over.length === 0) {
    console.log("ui strings: no file gained hardcoded text");
    return;
  }
  for (const { file, count, allowed } of over) {
    console.error(`${file}: ${count} hardcoded UI strings, ${allowed} allowed`);
  }
  console.error("\nMove new UI text into messages/en.json and messages/de.json (next-intl), see #168.");
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
