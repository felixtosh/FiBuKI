/**
 * `?.toDate()` sweep (fork #132), the follow-up #123 asked for.
 *
 * `?.` guards null and undefined and nothing else, so a value that is present
 * but not a Firestore Timestamp — a serialized `{seconds, nanoseconds}` bag, an
 * ISO string, a Date that already went through a codec — reaches `.toDate()`
 * and throws a TypeError. Inside an `onSnapshot` handler that takes the whole
 * listener down (#123's severity, not #53's, which only lost a rendered row).
 *
 * Two halves: `toDateSafe` degrades instead of throwing, and no source file
 * reintroduces the pattern.
 *
 * Covers repo-root lib/, app/, components/ and hooks/, so it runs under the
 * api-smoke profile (needs the root node_modules and the `@/` alias).
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { toDateSafe } from "@/lib/utils";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SWEPT_DIRS = ["app", "lib", "components", "hooks"];

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
});

describe("no source file reintroduces the pattern", () => {
  it("has no `?.toDate()` left in app, lib, components or hooks", () => {
    const offenders: string[] = [];
    for (const dir of SWEPT_DIRS) {
      for (const file of sourceFiles(path.join(REPO_ROOT, dir))) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (line.includes("?.toDate(")) {
            offenders.push(`${path.relative(REPO_ROOT, file)}:${i + 1}`);
          }
        });
      }
    }
    // Use toDateSafe from @/lib/utils instead: `?.` does not guard a value of
    // the wrong type, which is the entire failure mode.
    expect(offenders).toEqual([]);
  });
});
