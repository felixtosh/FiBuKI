/**
 * The model registry is one module now (#689), so the compiler keeps the
 * frontend and backend on the same roles and prices. What it cannot check is a
 * gap in the table: an unpriced model bills at PRICING_FALLBACK_MODEL (Claude
 * Sonnet's $3/$15), which for a Gemini Lite call overstates cost by ~20x and
 * feeds the AI budget / overage chain.
 */

import { describe, it, expect } from "vitest";
import { MODELS, MODEL_PRICING, PRICING_FALLBACK_MODEL, estimateModelCost } from "./models";

describe("model registry", () => {
  it("prices every model a role points at", () => {
    for (const [role, model] of Object.entries(MODELS)) {
      expect(MODEL_PRICING[model], `${role} -> ${model} has no pricing entry`).toBeDefined();
    }
  });

  it("prices the fallback model", () => {
    expect(MODEL_PRICING[PRICING_FALLBACK_MODEL]).toBeDefined();
  });

  it("keeps retired ids priced, so historical aiUsage still costs correctly", () => {
    // These are no longer selectable — Google 404s the Gemini ones for new API
    // consumers, and claude-3-haiku-20240307 lost its role when #170 retired the
    // vision-claude extraction path — but existing aiUsage rows reference them
    // forever, and an unpriced row bills at the Sonnet fallback.
    for (const retired of [
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.0-flash-001",
      "gemini-2.0-flash-lite-001",
      "gemini-2.5-flash-preview-05-20",
      "claude-3-5-haiku-20241022",
      "claude-3-haiku-20240307",
    ]) {
      expect(MODEL_PRICING[retired], `${retired} must stay priced`).toBeDefined();
    }
  });

  it("bills a priced model at its own rate and an unpriced one as the fallback", () => {
    expect(estimateModelCost(MODELS.geminiLite, 1_000_000, 1_000_000)).toBeCloseTo(0.25 + 1.5);
    const fallback = MODEL_PRICING[PRICING_FALLBACK_MODEL];
    expect(estimateModelCost("no-such-model", 1_000_000, 1_000_000)).toBeCloseTo(fallback.input + fallback.output);
  });
});
