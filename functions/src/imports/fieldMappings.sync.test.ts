/**
 * lib/import/field-definitions.ts cannot be imported here (functions rootDir is src), and the
 * browser must not import server code (#688), so the server keeps its own TRANSACTION_FIELDS
 * (import/columnFields.ts). The mapping check refuses a target field it does not know, so a field
 * the mapping UI offers and the server lacks would make every import with it fail: the keys are
 * compared as text.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IMPORT_TARGET_FIELDS } from "./fieldMappings";

describe("import target fields sync", () => {
  it("match the mapping UI's field definitions", () => {
    const source = readFileSync(join(__dirname, "..", "..", "..", "lib", "import", "field-definitions.ts"), "utf8");
    const frontend = [...source.matchAll(/^\s+key: "([A-Za-z]+)",$/gm)].map((m) => m[1]);
    expect(frontend.length).toBeGreaterThan(0);
    expect(frontend).toEqual([...IMPORT_TARGET_FIELDS]);
  });
});
