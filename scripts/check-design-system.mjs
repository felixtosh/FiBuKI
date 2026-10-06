#!/usr/bin/env node
// Keeps /design-system in step with the code. Every component in components/ui/
// has a `<name>.examples.tsx` next to it (a folder such as data-table/ has one
// `<folder>.examples.tsx` for the whole folder), every examples file is listed
// in the page's registry, and every theme token in app/globals.css is listed
// in the page's tokens.
//
//   node scripts/check-design-system.mjs          check (CI)
//   node scripts/check-design-system.mjs --list   print every component and its purpose
//                                                 (the new-component hook reads this)

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const UI = "components/ui";
const REGISTRY = "app/(dashboard)/design-system/registry.ts";
const TOKENS = "app/(dashboard)/design-system/tokens.ts";
const GLOBALS = "app/globals.css";
const LAYERS = ["primitive", "pattern", "brand"];

// A component that has no examples file on purpose, and why. Keep this short.
const EXCEPTIONS = {};

const read = (file) => readFileSync(join(ROOT, file), "utf8");

/** Each component (or folder of them) in components/ui and its examples file. */
export function uiUnits() {
  const units = [];
  for (const entry of readdirSync(join(ROOT, UI), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      units.push({ source: `${UI}/${entry.name}/`, examples: `${UI}/${entry.name}/${entry.name}.examples.tsx` });
    } else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".examples.tsx")) {
      units.push({ source: `${UI}/${entry.name}`, examples: `${UI}/${entry.name.replace(/\.tsx$/, ".examples.tsx")}` });
    }
  }
  return units.sort((a, b) => a.source.localeCompare(b.source));
}

/** The title, purpose and layer an examples file declares, as written. */
export function readDoc(source) {
  const field = (name) => source.match(new RegExp(`\\b${name}:\\s*"((?:[^"\\\\\\n]|\\\\.)*)"`))?.[1];
  return { title: field("title"), purpose: field("purpose")?.replace(/\\"/g, '"'), layer: field("layer") };
}

/** globals.css @theme tokens the page has to show: colors, durations, easings. */
export function themeTokens(css) {
  return [...new Set(css.match(/--(?:color|duration|ease)-[a-z0-9-]+(?=\s*:)/g) ?? [])];
}

export function problems() {
  const found = [];
  const registry = read(REGISTRY);
  for (const unit of uiUnits()) {
    if (unit.source in EXCEPTIONS) continue;
    if (!existsSync(join(ROOT, unit.examples))) {
      found.push(`${unit.source} has no ${unit.examples}`);
      continue;
    }
    const doc = readDoc(read(unit.examples));
    if (!doc.title) found.push(`${unit.examples} has no title: "..."`);
    if (!doc.purpose) found.push(`${unit.examples} has no one-line purpose: "..."`);
    if (!LAYERS.includes(doc.layer)) found.push(`${unit.examples} has no layer: ${LAYERS.map((l) => `"${l}"`).join(" | ")}`);
    if (!registry.includes(`"@/${unit.examples.replace(/\.tsx$/, "")}"`)) {
      found.push(`${unit.examples} is not imported in ${REGISTRY}`);
    }
  }
  const listed = read(TOKENS);
  for (const token of themeTokens(read(GLOBALS))) {
    if (!listed.includes(`"${token}"`)) found.push(`${GLOBALS} token ${token} is not listed in ${TOKENS}`);
  }
  return found;
}

function main() {
  if (process.argv.includes("--list")) {
    for (const unit of uiUnits()) {
      const doc = existsSync(join(ROOT, unit.examples)) ? readDoc(read(unit.examples)) : {};
      console.log(`- ${doc.title ?? unit.source} (${unit.source}, ${doc.layer ?? "?"}): ${doc.purpose ?? "no examples file yet"}`);
    }
    return;
  }
  const found = problems();
  if (found.length === 0) {
    console.log(`design system: ${uiUnits().length} components, all shown`);
    return;
  }
  console.error("The design system (/design-system) is out of step with the code:\n");
  for (const problem of found) console.error(`  ${problem}`);
  console.error(
    "\nEvery components/ui component gets a <name>.examples.tsx next to it (default export: ComponentDoc," +
      "\nsee lib/design-system/types.ts), imported in the registry. A new theme token goes into tokens.ts."
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
