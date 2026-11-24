/**
 * #685, the repair script's arguments and what it prints: a dry run by
 * default, --apply only against a reviewed dry run's report, --all-users
 * read-only, and every pair that needs a person named on the console.
 */

import { describe, it, expect } from "vitest";
import { parseRepairArgs, summaryLines } from "../transactions/repairApiTwinsCli";
import type { RepairReport } from "../transactions/repairApiTwins";

describe("the repair script's arguments", () => {
  it("runs a dry run for one User's Bank Account by default", () => {
    expect(parseRepairArgs(["--user", "u1", "--source", "s1", "--out-dir", "/tmp/x"])).toEqual({
      mode: "repair", userId: "u1", sourceId: "s1", outDir: "/tmp/x", apply: false,
    });
    expect(parseRepairArgs(["--user", "u1", "--source", "s1", "--out-dir", "/tmp/x", "--dry-run"])).toMatchObject({ apply: false });
  });

  it("applies only with the reviewed dry run's report", () => {
    expect(parseRepairArgs(["--user", "u1", "--source", "s1", "--out-dir", "/tmp/x", "--apply", "--reviewed", "/tmp/x/r.json"])).toEqual({
      mode: "repair", userId: "u1", sourceId: "s1", outDir: "/tmp/x", apply: true, reviewedPath: "/tmp/x/r.json",
    });
    expect(parseRepairArgs(["--user", "u1", "--source", "s1", "--out-dir", "/tmp/x", "--apply"])).toMatchObject({ mode: "error" });
    expect(parseRepairArgs(["--user", "u1", "--source", "s1", "--out-dir", "/tmp/x", "--apply", "--dry-run", "--reviewed", "r"])).toMatchObject({ mode: "error" });
  });

  it("surveys every User read-only and refuses to combine that with a repair", () => {
    expect(parseRepairArgs(["--all-users", "--out-dir", "/tmp/x"])).toEqual({ mode: "survey", outDir: "/tmp/x" });
    expect(parseRepairArgs(["--all-users", "--out-dir", "/tmp/x", "--apply"])).toMatchObject({ mode: "error" });
    expect(parseRepairArgs(["--all-users", "--out-dir", "/tmp/x", "--user", "u1"])).toMatchObject({ mode: "error" });
  });

  it("needs an out dir, and a User with a Bank Account", () => {
    expect(parseRepairArgs(["--user", "u1", "--source", "s1"])).toMatchObject({ mode: "error" });
    expect(parseRepairArgs(["--user", "u1", "--out-dir", "/tmp/x"])).toMatchObject({ mode: "error" });
    expect(parseRepairArgs(["--user", "--source", "s1", "--out-dir", "/tmp/x"])).toMatchObject({ mode: "error" });
    expect(parseRepairArgs(["--help"])).toEqual({ mode: "help" });
  });
});

describe("what the repair prints", () => {
  it("names every pair that needs a person, a note included", () => {
    const report: RepairReport = {
      apply: false, userId: "u1", sourceId: "s1", legacyImports: { api_1750000000001: 2 },
      merges: [
        { kind: "merge", apiId: "a1", csvId: "c1", moves: [], unlinkOnly: [], partner: null, category: null, quota: "none",
          notes: ["api-complete-without-evidence"], done: false, invoiceFileIds: [] },
      ],
      decisions: [{ kind: "decision", apiId: "a2", csvId: "c2", reason: "api-holds-state", fields: ["vatRate"] }],
      blocked: [], unmatched: [], ambiguous: [], unpairable: [], failed: [], skipped: [],
    };
    const lines = summaryLines(report);
    expect(lines).toContain("  note a1 / c1: api-complete-without-evidence");
    expect(lines).toContain("  decide a2 / c2: api-holds-state (vatRate)");
  });
});
