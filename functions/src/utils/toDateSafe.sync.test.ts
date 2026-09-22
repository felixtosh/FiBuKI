/**
 * `toDateSafe` exists TWICE and neither copy can import the other:
 * functions/tsconfig.json pins `rootDir: "src"`, so the backend cannot reach
 * repo-root lib/, and lib/utils.ts pulls in clsx/tailwind-merge, which the
 * functions tree does not carry. Same boundary, and the same resolution, as the
 * model registry — see models.sync.test.ts.
 *
 * Drift here is silent in the same way: the optional-chained `toDate()` ratchet
 * (api-smoke/todate-guard.test.ts) now sweeps functions/src on the strength of
 * "those call sites go through toDateSafe", but it tests only the repo-root
 * copy. A guard fixed on one side and not the other leaves the server reading a
 * malformed `{seconds: null}` as 1970 while the client reads it as absent, and
 * nothing fails until an accounting date is wrong.
 *
 * So this reads both files as TEXT and compares the function bodies. Text, not
 * imports, precisely because importing across that boundary is what tsconfig
 * forbids.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../../..");
const FRONTEND = path.join(REPO, "lib/utils.ts");
const BACKEND = path.join(REPO, "functions/src/utils/toDateSafe.ts");

/**
 * The body of `toDateSafe` in `file`, comments and whitespace stripped, so the
 * two copies compare on behaviour and not on how each file is formatted or
 * which surrounding prose it carries.
 */
function extractBody(file: string): string {
  const src = readFileSync(file, "utf8");
  const start = src.indexOf("export function toDateSafe(");
  if (start === -1) return "";
  const open = src.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (end === -1) return "";
  return src
    .slice(open + 1, end - 1)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

describe("toDateSafe: the two hand-duplicated copies agree", () => {
  it("parsed both files at all — a rename must fail loudly, not vacuously pass", () => {
    expect(extractBody(FRONTEND).length).toBeGreaterThan(0);
    expect(extractBody(BACKEND).length).toBeGreaterThan(0);
  });

  it("has the same body on both sides", () => {
    expect(extractBody(BACKEND)).toBe(extractBody(FRONTEND));
  });
});
