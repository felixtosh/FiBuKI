/**
 * Invoice money math exists TWICE and neither copy can import the other:
 * functions/tsconfig.json pins `rootDir: "src"`, so the server PDF renderer
 * cannot reach the app's `types/invoice.ts` (which `lib/invoicing/invoice-totals.ts`
 * re-exports for the in-app preview and the public `/i/[token]` view), and the
 * app does not import from functions/. The copy in functions/src/invoicing/types.ts
 * was declared "byte-identical" by comment only.
 *
 * The failure mode of drift is not a crash: the stored, issued PDF and the
 * invoice the recipient sees on screen would print different totals for the
 * same invoice. So this reads both files as TEXT and compares the functions.
 * Text, not imports, for the same reason as utils/models.sync.test.ts: importing
 * across that boundary is what tsconfig forbids.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../../..");
const APP_TYPES = path.join(REPO, "types/invoice.ts");
const APP_TOTALS = path.join(REPO, "lib/invoicing/invoice-totals.ts");
const SERVER_TYPES = path.join(REPO, "functions/src/invoicing/types.ts");
const SERVER_RENDERER = path.join(REPO, "functions/src/invoicing/invoiceDocument.tsx");

const SYNCED = ["computeLineItemTotals", "computeInvoiceTotals"];

/**
 * The full `export function name(...) {...}` source: from its declaration to the
 * first line that is only `}`, which is how both files close a top-level function.
 * Whitespace is collapsed so re-indenting is not drift; anything else is.
 */
function functionSource(file: string, name: string): string {
  const src = readFileSync(file, "utf8");
  const start = src.indexOf(`export function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in ${path.relative(REPO, file)}`);
  // A line holding only `}`. Not merely "`}` at column 0": a multi-line return
  // type annotation closes with `} {` there too, which would cut off the body.
  const close = /\n\}[ \t]*(?:\r?\n|$)/.exec(src.slice(start));
  if (!close) throw new Error(`${name}: no closing brace on a line of its own`);
  return src
    .slice(start, start + close.index + 2)
    .replace(/\s+/g, " ")
    .trim();
}

describe("invoice totals: the two hand-duplicated copies agree", () => {
  it.each(SYNCED)("%s is identical in the app and in functions/", (name) => {
    const app = functionSource(APP_TYPES, name);
    const server = functionSource(SERVER_TYPES, name);
    // A rename or a parse slip must fail loudly, not compare two empty strings.
    expect(app).toContain(`export function ${name}(`);
    expect(app).toContain("return {");
    expect(server).toBe(app);
  });

  it("the app helper re-exports the canonical copy rather than forking a third", () => {
    const src = readFileSync(APP_TOTALS, "utf8");
    expect(src).toMatch(/from\s+"@\/types\/invoice"/);
    for (const name of SYNCED) {
      expect(src).not.toContain(`function ${name}(`);
    }
  });

  it("both renderers print NET in the line amount column", () => {
    // The rule the two copies exist to keep aligned (Austrian convention: the
    // line column is net, only "Gesamt" is gross). The app renderers go through
    // lineItemColumnCents; the server PDF calls the functions/ copy inline.
    expect(functionSource(APP_TOTALS, "lineItemColumnCents")).toContain(
      "return computeLineItemTotals(item).netCents;",
    );
    expect(readFileSync(SERVER_RENDERER, "utf8")).toContain(
      "computeLineItemTotals(item).netCents",
    );
  });
});
