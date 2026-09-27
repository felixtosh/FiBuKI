/**
 * #308 — keep File/Transaction scoring inputs assembled in one place.
 *
 * Every hand-built copy of `scoreTransaction`'s inputs has drifted: the agent
 * tool dropped the tip (#217), the Remainder (#239) and the bank-stated
 * original (#112), the connect dialog the precision-search hint. Each surface
 * now goes through `scoreFileAgainstTransactions`, which builds both sides via
 * `toFileMatchingData` / `toTransactionData`. A new direct caller of
 * `scoreTransaction` would be a new copy to keep in step, so it fails here and
 * has to either use that function or be added below with its reason.
 * `selfhost/scorer-parity.test.ts` checks that the surfaces agree.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SRC = join(__dirname, "..", "..");

const ALLOWED_CALLERS = new Set([
  // Home of the shared assembly itself.
  "matching/transactionScoring.ts",
  // Re-scores already-connected pairs: builds via toFileMatchingData /
  // toTransactionData, and deliberately scores against the full amount.
  "matching/rescoreFileConnections.ts",
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "__tests__" || name === "node_modules" ? [] : sourceFiles(path);
    }
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("scoreTransaction callers", () => {
  it("are only the shared input assembly and the allowlisted re-scorer", () => {
    const callers = sourceFiles(SRC)
      .filter((path) => /\bscoreTransaction\s*\(/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path).split("\\").join("/"));

    expect(callers.filter((c) => !ALLOWED_CALLERS.has(c))).toEqual([]);
  });
});
