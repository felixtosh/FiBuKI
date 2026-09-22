/**
 * `?.toDate()` sweep (fork #132), the follow-up #123 asked for, tightened by #112.
 *
 * `?.` guards null and undefined and nothing else, so a value that is present
 * but not a Firestore Timestamp — a serialized `{seconds, nanoseconds}` bag, an
 * ISO string, a Date that already went through a codec — reaches `.toDate()`
 * and throws a TypeError. Inside an `onSnapshot` handler that takes the whole
 * listener down (#123's severity, not #53's, which only lost a rendered row).
 *
 * Two halves: `toDateSafe` degrades instead of throwing, and no source file
 * reintroduces the pattern. #112 closed two blind spots in the second half:
 * the match used to be line-scoped, so a chain the formatter wrapped across
 * lines was invisible to it, and the swept set stopped at the client — the
 * functions/ tree had 13 live `?.toDate()` call sites of its own.
 *
 * Covers repo-root lib/, app/, components/, hooks/ and functions/src, so it
 * runs under the api-smoke profile (needs the root node_modules and the `@/`
 * alias). This file matches its own doc comment's `?.toDate()` mentions, so
 * it excludes itself from the sweep rather than rewording around the regex.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { toDateSafe } from "@/lib/utils";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SWEPT_DIRS = ["app", "lib", "components", "hooks", "functions/src"];
const SELF = path.resolve(__filename);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Line numbers (1-based) of every unguarded `?.toDate(` call in `content`.
 * `\s*` between the two tokens is what catches a chain the formatter wrapped
 * across lines — a single-line-scoped check would miss `foo?.\n  toDate()`.
 */
function findUnguardedToDateCalls(content: string): number[] {
  const lines: number[] = [];
  for (const match of content.matchAll(/\?\.\s*toDate\s*\(/g)) {
    lines.push(content.slice(0, match.index).split("\n").length);
  }
  return lines;
}

describe("toDateSafe", () => {
  const when = new Date("2026-02-01T10:00:00.000Z");

  it("reads every timestamp shape the app actually stores", () => {
    expect(toDateSafe({ toDate: () => when })).toEqual(when);
    expect(toDateSafe({ seconds: when.getTime() / 1000, nanoseconds: 0 })).toEqual(when);
    expect(toDateSafe(when)).toEqual(when);
    expect(toDateSafe(when.toISOString())).toEqual(when);
  });

  it("returns null for what used to throw, instead of throwing", () => {
    // Each of these reaches `.toDate()` through an optional chain unharmed,
    // because none of them is null or undefined.
    expect(toDateSafe("not a date at all")).toBeNull();
    expect(toDateSafe(1_770_000_000_000)).toBeNull();
    expect(toDateSafe({ nanoseconds: 0 })).toBeNull();
    expect(toDateSafe({})).toBeNull();
    expect(toDateSafe(null)).toBeNull();
    expect(toDateSafe(undefined)).toBeNull();
  });

  it("returns null for a malformed serialized timestamp instead of the epoch or an Invalid Date", () => {
    // A JSONB round trip on self-host produces {seconds: null, ...} for a null
    // timestamp column. `null * 1000` is 0, which used to read as 1970-01-01 —
    // a plausible-looking date, not an absence.
    expect(toDateSafe({ seconds: null, nanoseconds: null })).toBeNull();
    // `undefined * 1000` is NaN, so this used to produce an Invalid Date,
    // which `?.` does not guard because it is neither null nor undefined.
    expect(toDateSafe({ seconds: undefined })).toBeNull();
    // A string is not a number: the seconds branch must not coerce it.
    expect(toDateSafe({ seconds: "1700000000" })).toBeNull();
  });

  it("keeps a genuine zero seconds, which is a date and not an absence", () => {
    // The tempting one-line fix for the epoch bug is `if (!ts.seconds) return null`,
    // which would also throw away 1970-01-01 itself — a real, storable instant.
    expect(toDateSafe({ seconds: 0, nanoseconds: 0 })).toEqual(new Date(0));
    // Negative seconds are pre-1970, equally real.
    expect(toDateSafe({ seconds: -86400, nanoseconds: 0 })).toEqual(new Date(-86400000));
  });

  it("returns null for seconds that are numeric but not finite", () => {
    expect(toDateSafe({ seconds: NaN })).toBeNull();
    expect(toDateSafe({ seconds: Infinity })).toBeNull();
  });

  it("still returns the correct Date, to the millisecond, for a valid pair", () => {
    expect(toDateSafe({ seconds: when.getTime() / 1000, nanoseconds: 500_000_000 })).toEqual(
      new Date(when.getTime() + 500)
    );
  });
});

describe("findUnguardedToDateCalls", () => {
  it("catches a single-line chain", () => {
    expect(findUnguardedToDateCalls("const d = value?.toDate();")).toEqual([1]);
  });

  it("catches a chain the formatter wrapped across lines", () => {
    const wrapped = "const d = value\n  ?.\n  toDate();";
    expect(findUnguardedToDateCalls(wrapped)).toEqual([2]);
  });

  it("does not flag a call already routed through toDateSafe", () => {
    expect(findUnguardedToDateCalls("const d = toDateSafe(value);")).toEqual([]);
  });
});

describe("no source file reintroduces the pattern", () => {
  it("has no `?.toDate()` left in app, lib, components, hooks or functions/src", () => {
    const offenders: string[] = [];
    for (const dir of SWEPT_DIRS) {
      for (const file of sourceFiles(path.join(REPO_ROOT, dir))) {
        if (path.resolve(file) === SELF) continue;
        const content = readFileSync(file, "utf8");
        for (const line of findUnguardedToDateCalls(content)) {
          offenders.push(`${path.relative(REPO_ROOT, file)}:${line}`);
        }
      }
    }
    // Use toDateSafe from @/lib/utils (or functions/src/utils/toDateSafe.ts on
    // the server side) instead: `?.` does not guard a value of the wrong
    // type, which is the entire failure mode.
    expect(offenders).toEqual([]);
  });
});
