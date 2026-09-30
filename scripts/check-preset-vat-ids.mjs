#!/usr/bin/env node
// Checks every VAT id in lib/data/preset-partners.ts against VIES, the EU's
// VAT registry (#361). A preset VAT id keys matching and Global Partner
// promotion, so a number that does not exist, or belongs to another company,
// routes other people's invoices to the wrong Partner. Run after adding or
// editing a preset:
//
//   node scripts/check-preset-vat-ids.mjs
//
// Needs network; not part of CI (VIES is slow and rate-limited). Exits 1 when
// any id is invalid, so a failing id is removed or corrected before it lands.
// VIES does not return names for some states (e.g. DE), so a valid number
// there is only as good as its source: add those with care.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const source = readFileSync(join(ROOT, "lib", "data", "preset-partners.ts"), "utf8");
const presets = [...source.matchAll(/\{\s*name:\s*"([^"]+)"[^\n]*?vatId:\s*"([A-Z]{2}[A-Z0-9]+)"/g)].map(
  (m) => ({ name: m[1], vatId: m[2] })
);

const TRANSIENT = /MS_UNAVAILABLE|TIMEOUT|MS_MAX_CONCURRENT|SERVICE_UNAVAILABLE/;

async function lookup(vatId) {
  const url = `https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${vatId.slice(0, 2)}/vat/${vatId.slice(2)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const body = await (await fetch(url)).json();
      if (body.userError && TRANSIENT.test(body.userError)) throw new Error(body.userError);
      return body;
    } catch (error) {
      if (attempt === 2) return { isValid: null, userError: String(error) };
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

let failures = 0;
for (const preset of presets) {
  const result = await lookup(preset.vatId);
  const name = (result.name || "").replace(/\s+/g, " ").trim();
  if (result.isValid === true) {
    console.log(`ok       ${preset.vatId.padEnd(16)} ${preset.name}  (VIES: ${name || "no name returned"})`);
  } else {
    failures++;
    const state = result.isValid === false ? "INVALID" : "UNKNOWN";
    console.log(`${state.padEnd(8)} ${preset.vatId.padEnd(16)} ${preset.name}  ${result.userError ?? ""}`);
  }
  await new Promise((r) => setTimeout(r, 250));
}

console.log(`\n${presets.length} preset VAT ids checked, ${failures} not confirmed by VIES.`);
console.log("Also compare each VIES name above with the preset: a valid number can belong to another company.");
process.exit(failures > 0 ? 1 : 0);
