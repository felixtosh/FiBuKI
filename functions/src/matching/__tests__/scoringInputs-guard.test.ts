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
 * keep in step, so it fails here, anywhere in the repo: the functions, the
 * agent's tools, the web app. There are no exceptions: a new surface calls
 * the matcher.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const REPO = join(__dirname, "..", "..", "..", "..");
/** Where code that could score, filter candidates or set a window lives. */
const SOURCE_DIRS = ["functions/src", "lib", "app", "components", "hooks", "types"];
/** The browser's code: it reads no Rejection, it shows the matcher's answer. */
const BROWSER_DIRS = ["app", "components", "hooks"];

const MATCHER = "functions/src/matching/matcher.ts";
/** The scoring core itself, which defines what is guarded. */
const CORE = "functions/src/matching/transactionScoring.ts";

const SKIP_DIRS = new Set(["__tests__", "node_modules", ".next"]);

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return SKIP_DIRS.has(name) ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) ? [path] : [];
  });
}

function filesMatching(dirs: string[], pattern: RegExp): string[] {
  return dirs
    .flatMap((dir) => sourceFiles(join(REPO, dir)))
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(REPO, path).split("\\").join("/"))
    .filter((file) => file !== MATCHER && file !== CORE);
}

describe("only the matcher", () => {
  it("calls the scoring core", () => {
    expect(filesMatching(SOURCE_DIRS, /\bscoreTransaction\s*\(/)).toEqual([]);
  });

  it("assembles the scoring inputs", () => {
    expect(
      filesMatching(
        SOURCE_DIRS,
        /\b(toFileMatchingData|toTransactionData|loadPartnerScoringContext|buildScoringOptions)\s*\(/
      )
    ).toEqual([]);
  });

  it("keeps a date window: no second copy of its number exists", () => {
    // The one number is MATCH_WINDOW_DAYS (matching/matchWindow.ts), which the
    // app's own description of matching prints too.
    expect(filesMatching(SOURCE_DIRS, /\bDATE_RANGE_DAYS\b/)).toEqual([]);
  });
});

describe("the browser", () => {
  it("reads no Rejection: which pairs are held back is the matcher's answer", () => {
    expect(
      filesMatching(BROWSER_DIRS, /from\s+["'][^"']*matching\/(rejectedFiles|dismissedTransactions)["']/)
    ).toEqual([]);
  });
});
