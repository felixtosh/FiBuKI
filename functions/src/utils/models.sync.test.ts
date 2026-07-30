/**
 * The model registry exists TWICE and neither copy can import the other:
 * functions/tsconfig.json pins `rootDir: "src"`, so the backend cannot reach
 * ../../types/, and the frontend cannot reach into functions/. CLAUDE.md resolves
 * that with "keep both files in sync", which is a convention, and conventions drift
 * silently — the failure mode is not a crash but MIS-BILLING: a model priced in one
 * file and not the other falls back to Claude Sonnet's $3/$15, which for a Gemini
 * Lite call overstates cost by ~20x and feeds the AI budget / overage chain.
 *
 * So this reads both files as TEXT and compares. Text, not imports, precisely
 * because importing across that boundary is what tsconfig forbids.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../../..");
const FRONTEND = path.join(REPO, "types/ai-usage.ts");
const BACKEND = path.join(REPO, "functions/src/utils/models.ts");

type Price = { input: number; output: number };

/** Both files write entries as `"model-id": { input: N, output: N },`. */
function parsePricing(file: string): Record<string, Price> {
  const src = readFileSync(file, "utf8");
  const out: Record<string, Price> = {};
  for (const m of src.matchAll(
    /"([A-Za-z0-9._-]+)":\s*\{\s*input:\s*([\d.]+),\s*output:\s*([\d.]+)\s*\}/g,
  )) {
    // parseFloat, so 1.50 and 1.5 compare equal — the files format differently and
    // that is cosmetic, not drift.
    out[m[1]] = { input: parseFloat(m[2]), output: parseFloat(m[3]) };
  }
  return out;
}

function parseRoles(file: string): Record<string, string> {
  const src = readFileSync(file, "utf8");
  const out: Record<string, string> = {};
  for (const m of src.matchAll(
    /\b(geminiLite|geminiFlash|chatAgent|claudeHaiku):\s*"([^"]+)"/g,
  )) {
    out[m[1]] = m[2];
  }
  return out;
}

const feRoles = parseRoles(FRONTEND);
const beRoles = parseRoles(BACKEND);
const fePrices = parsePricing(FRONTEND);
const bePrices = parsePricing(BACKEND);

describe("model registry: the two hand-duplicated copies agree", () => {
  it("parsed both files at all — a rename must fail loudly, not vacuously pass", () => {
    expect(Object.keys(feRoles).length).toBeGreaterThan(0);
    expect(Object.keys(beRoles).length).toBeGreaterThan(0);
    expect(Object.keys(fePrices).length).toBeGreaterThan(0);
    expect(Object.keys(bePrices).length).toBeGreaterThan(0);
  });

  it("maps every role to the same model id", () => {
    expect(feRoles).toEqual(beRoles);
  });

  it("prices every model identically in both files", () => {
    expect(fePrices).toEqual(bePrices);
  });

  it("prices every model a role points at", () => {
    // The real cost of a gap: PRICING_FALLBACK_MODEL is Claude Sonnet, so an
    // unpriced Gemini call is billed at roughly 20x its true rate.
    for (const [role, model] of Object.entries(beRoles)) {
      expect(bePrices[model], `${role} -> ${model} has no pricing entry`).toBeDefined();
    }
  });

  it("keeps retired ids priced, so historical aiUsage still costs correctly", () => {
    // These are no longer selectable (Google 404s them for new API consumers) but
    // existing aiUsage rows reference them forever.
    for (const retired of ["gemini-2.5-flash", "gemini-2.5-flash-lite"]) {
      expect(bePrices[retired], `${retired} must stay priced`).toBeDefined();
    }
  });
});
