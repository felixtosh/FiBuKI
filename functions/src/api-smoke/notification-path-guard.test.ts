/**
 * Notifications are written where they are read, or not at all.
 *
 * Every reader subscribes to the per-user subcollection
 * `users/{userId}/notifications` — see `hooks/use-notifications.ts`. A write to
 * a top-level `notifications` collection produces a document nobody queries: no
 * error, no missing row anywhere, just a notification the user never sees.
 *
 * This has now happened twice. The Gmail connect path and the re-auth reminder
 * wrote to the top level until this bundle; the IMAP connect path was written
 * later, against the older example, and repeated it. A ratchet is cheaper than
 * finding it a third time.
 *
 * Matching is done over whole file text rather than line by line, so a call the
 * formatter wrapped across lines still trips it. The trailing comma prettier
 * adds when it wraps is part of that: without it in the pattern, the wrapped
 * form is exactly the one that slips through.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SCANNED_DIRS = ["app", "lib", "components", "hooks", "functions/src"];

/** This file quotes the forbidden shapes, so it cannot scan itself. */
const SELF = path.join("functions", "src", "api-smoke", "notification-path-guard.test.ts");

/**
 * Both SDK spellings of a top-level `notifications` collection: the Admin SDK's
 * `db.collection("notifications")` and the client SDK's
 * `collection(db, "notifications")`. Whitespace is allowed anywhere the
 * formatter might introduce it.
 */
const FORBIDDEN = [
  /\.collection\(\s*["'`]notifications["'`]\s*,?\s*\)/,
  /\bcollection\(\s*[\w.$]+\s*,\s*["'`]notifications["'`]\s*,?\s*\)/,
];

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

describe("notifications are written to the subcollection the app reads", () => {
  it("has no write to a top-level `notifications` collection", () => {
    const offenders: string[] = [];

    for (const dir of SCANNED_DIRS) {
      for (const file of sourceFiles(path.join(REPO_ROOT, dir))) {
        const relative = path.relative(REPO_ROOT, file);
        if (relative === SELF) continue;

        const text = readFileSync(file, "utf8");
        if (FORBIDDEN.some((pattern) => pattern.test(text))) {
          offenders.push(relative);
        }
      }
    }

    // Write to `users/${userId}/notifications` instead. The top-level
    // collection has no reader, so a document there is silently lost.
    expect(offenders).toEqual([]);
  });
});
