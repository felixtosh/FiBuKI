/**
 * #308, #613 — one matcher, reached by every surface.
 *
 * Every hand-built copy of the scoring inputs has drifted: the agent tool
 * dropped the tip (#217), the Remainder (#239) and the bank-stated original
 * (#112), the connect dialog the precision-search hint; every hand-built
 * candidate filter dropped a Rejection, the over-quota block or the
 * foreign-recipient rule somewhere (#613). The matcher (`matching/matcher.ts`)
 * now owns candidate selection, the date window, input assembly and the call
 * into the scoring core. A second caller of any of them is a second copy to
 * keep in step, so it fails here. There are no exceptions: a new surface
 * calls the matcher.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SRC = join(__dirname, "..", "..");
const MATCHER = "matching/matcher.ts";
/** The scoring core itself, which defines what is guarded. */
const CORE = "matching/transactionScoring.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "__tests__" || name === "node_modules" ? [] : sourceFiles(path);
    }
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

function filesMatching(pattern: RegExp): string[] {
  return sourceFiles(SRC)
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(SRC, path).split("\\").join("/"))
    .filter((file) => file !== MATCHER && file !== CORE);
}

describe("only the matcher", () => {
  it("calls the scoring core", () => {
    expect(filesMatching(/\bscoreTransaction\s*\(/)).toEqual([]);
  });

  it("assembles the scoring inputs", () => {
    expect(
      filesMatching(/\b(toFileMatchingData|toTransactionData|loadPartnerScoringContext|buildScoringOptions)\s*\(/)
    ).toEqual([]);
  });

  it("computes the date window", () => {
    expect(filesMatching(/\bDATE_RANGE_DAYS\b/)).toEqual([]);
  });
});
