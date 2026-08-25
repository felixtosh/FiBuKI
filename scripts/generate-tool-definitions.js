#!/usr/bin/env node

/**
 * Generate Tool Definitions
 *
 * Imports the compiled tool definitions from functions/lib and generates
 * a static TypeScript file for the Next.js app to consume.
 *
 * Prerequisites: Functions must be compiled (lib/ folder must exist)
 * Run: npm run generate:tool-definitions
 */

const fs = require("fs");
const path = require("path");

const DEFINITIONS_PATH = path.join(__dirname, "..", "functions", "lib", "tools", "definitions.js");
const OUTPUT_PATH = path.join(__dirname, "..", "lib", "data", "generated-tool-definitions.ts");

if (!fs.existsSync(DEFINITIONS_PATH)) {
  console.error("Error: Functions not built. Run 'npm run build' in functions/ first.");
  console.error(`Expected: ${DEFINITIONS_PATH}`);
  process.exit(1);
}

// definitions.ts has zero Firebase imports, so no mocking needed
const { TOOL_DEFINITIONS } = require(DEFINITIONS_PATH);

function main() {
  console.log(`Found ${TOOL_DEFINITIONS.length} tool definitions`);

  // No generation timestamp: it made every regeneration a diff, which is why
  // CI cannot simply check the committed file against a fresh run. The drift
  // check in .github/workflows/ci.yml is the staleness signal now, and it
  // cannot be two months late the way a timestamp can.
  const lines = [
    "// AUTO-GENERATED — DO NOT EDIT",
    "// Source: functions/src/tools/definitions.ts",
    "// Regenerate: npm run generate:tool-definitions",
    "",
    "export interface ToolDefinition {",
    "  name: string;",
    "  description: string;",
    '  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };',
    "  requiredFeature?: string;",
    "}",
    "",
    `export const TOOL_DEFINITIONS: ToolDefinition[] = ${JSON.stringify(TOOL_DEFINITIONS, null, 2)};`,
    "",
    "export const TOOL_NAMES: string[] = TOOL_DEFINITIONS.map((t) => t.name);",
    "",
  ];

  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(OUTPUT_PATH, lines.join("\n"), "utf-8");
  console.log(`Generated: ${OUTPUT_PATH}`);
}

main();
