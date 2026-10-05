/**
 * The MCP correction tool and the UI's correction callable take one contract,
 * defined by the File facts module (#638, #637 user story 19). The callable
 * takes the module's types directly; the tool's schema is written out for MCP
 * clients, so it is held to the module's field lists here.
 *
 *   npx vitest run src/fileFacts/__tests__/correction-contract.test.ts --pool=forks --maxWorkers=1
 */

import { describe, it, expect } from "vitest";
import { TOOL_DEFINITIONS } from "../../tools/definitions";
import { CORRECTABLE_FIELDS } from "../provenance";
import { DESCRIPTIVE_FIELDS } from "../handCorrection";

describe("update_file_extraction's schema", () => {
  it("names exactly the module's fields, plus the File and the tip declaration", () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "update_file_extraction");
    const properties = Object.keys(
      (tool?.inputSchema as { properties: Record<string, unknown> }).properties
    ).sort();

    expect(properties).toEqual(
      ["fileId", "tipNotPrinted", ...CORRECTABLE_FIELDS, ...Object.keys(DESCRIPTIVE_FIELDS)].sort()
    );
  });
});
