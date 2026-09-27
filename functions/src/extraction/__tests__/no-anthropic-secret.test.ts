/**
 * #309: since #170 retired the vision-claude path, extraction calls Gemini
 * only. The functions that run extraction, or dispatch the tool that runs it,
 * used to declare ANTHROPIC_API_KEY anyway, which told the next reader they
 * still called Anthropic. This pins that they no longer do.
 *
 * The chat agent's key is not covered here: it lives outside these modules.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../..");

const EXTRACTION_ENTRY_POINTS = [
  "extraction/extractFileData.ts",
  "extraction/retryExtraction.ts",
  "extraction/bulkRetryExtraction.ts",
  "mcp-api/index.ts",
  "mcp-api/mcp-sse.ts",
  "tools/handlers.ts",
];

describe("extraction entry points", () => {
  it.each(EXTRACTION_ENTRY_POINTS)("%s declares no ANTHROPIC_API_KEY secret", (file) => {
    const source = readFileSync(path.join(SRC, file), "utf8");
    expect(source).not.toMatch(/defineSecret\(\s*["']ANTHROPIC_API_KEY["']\s*\)/);
    expect(source).not.toMatch(/anthropicApiKey/);
  });

  it("no longer carries the retired Google Vision client", () => {
    expect(existsSync(path.join(SRC, "extraction/visionApi.ts"))).toBe(false);
  });
});
