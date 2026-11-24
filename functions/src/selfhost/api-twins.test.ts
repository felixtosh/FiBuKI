/**
 * #685: Transactions an MCP import stored before it checked for duplicates,
 * and a later CSV import of the same Bank Account stored again. The pairing
 * and the merge plan are pure; these tests hold them to the issue's rules
 * without a database.
 */

import { describe, it, expect } from "vitest";
import { importKind, pairTwins, planTwinMerge, type TwinRow } from "../transactions/apiTwins";

const API_A = "api_1750000000001";
const API_B = "api_1750000000002";
const CSV = "import_1755000000000_abc1234";

function row(id: string, importJobId: string | null, day: string, amount: number, name = "SHOP"): TwinRow {
  return { id, importJobId, day, amount, name };
}

describe("which import a row came from", () => {
  it("knows the old MCP id format, the CSV import and everything else", () => {
    expect(importKind("api_1750000000001")).toBe("legacy-api");
    // The current tool id carries a random suffix and was deduplicated.
    expect(importKind("api_1750000000001_ab12cd34")).toBe("other");
    expect(importKind("import_1755000000000_abc1234")).toBe("csv");
    expect(importKind("draftImportDocId")).toBe("csv");
    expect(importKind("sync_src_1755000000000")).toBe("other");
    expect(importKind("finapi_sync_src_1755000000000")).toBe("other");
    expect(importKind(null)).toBe("other");
  });
});

describe("pairing API rows with their CSV twins", () => {
  it("pairs one API row with the one CSV row of the same day and amount", () => {
    const result = pairTwins([
      row("a1", API_A, "2026-03-02", -1999),
      row("c1", CSV, "2026-03-02", -1999, "Shop GmbH"),
      row("c2", CSV, "2026-03-02", -500),
    ]);
    expect(result.pairs).toEqual([{ apiId: "a1", csvId: "c1" }]);
    expect(result.unmatched).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  it("reports an API row with no CSV twin, and never pairs across days or amounts", () => {
    const result = pairTwins([
      row("a1", API_A, "2026-03-02", -1999),
      row("c1", CSV, "2026-03-03", -1999),
      row("c2", CSV, "2026-03-02", -2000),
    ]);
    expect(result.pairs).toEqual([]);
    expect(result.unmatched).toEqual(["a1"]);
  });

  it("pairs a day-and-amount group of several by name, and reports what the name does not settle", () => {
    const result = pairTwins([
      row("a1", API_A, "2026-04-01", -1000, "AMAZON* 111"),
      row("a2", API_B, "2026-04-01", -1000, "AMAZON* 222"),
      row("c1", CSV, "2026-04-01", -1000, "amazon*  222"),
      row("c2", CSV, "2026-04-01", -1000, "Amazon* 111"),
      // Two API rows, two CSV rows, names that settle nothing.
      row("a3", API_A, "2026-04-02", -300, "CARD"),
      row("a4", API_A, "2026-04-02", -300, "CARD"),
      row("c3", CSV, "2026-04-02", -300, "Card"),
      row("c4", CSV, "2026-04-02", -300, "Card"),
    ]);
    expect(result.pairs).toEqual([
      { apiId: "a1", csvId: "c2" },
      { apiId: "a2", csvId: "c1" },
    ]);
    expect(result.ambiguous).toEqual([{ apiIds: ["a3", "a4"], csvIds: ["c3", "c4"] }]);
  });

  it("reports more API rows than CSV rows on a day and amount as ambiguous", () => {
    const result = pairTwins([
      row("a1", API_A, "2026-04-01", -1000, "X"),
      row("a2", API_B, "2026-04-01", -1000, "Y"),
      row("c1", CSV, "2026-04-01", -1000, "Z"),
    ]);
    expect(result.pairs).toEqual([]);
    expect(result.ambiguous).toEqual([{ apiIds: ["a1", "a2"], csvIds: ["c1"] }]);
  });

  it("ignores rows of other imports and API rows of the current id format", () => {
    const result = pairTwins([
      row("a1", "api_1750000000001_ab12cd34", "2026-03-02", -1999),
      row("s1", "sync_src_1", "2026-03-02", -1999),
      row("c1", CSV, "2026-03-02", -1999),
    ]);
    expect(result.pairs).toEqual([]);
    expect(result.unmatched).toEqual([]);
  });
});

describe("planning one pair's merge", () => {
  const api = (extra: Record<string, unknown> = {}) => ({ id: "a1", data: { userId: "u", fileIds: [], ...extra } });
  const csv = (extra: Record<string, unknown> = {}) => ({ id: "c1", data: { userId: "u", fileIds: [], ...extra } });
  const rec = (fileId: string, transactionId: string, extra: Record<string, unknown> = {}) => ({
    id: `${fileId}__${transactionId}`,
    data: { userId: "u", fileId, transactionId, ...extra },
  });
  const file = (extra: Record<string, unknown> = {}) => ({ userId: "u", transactionIds: [], ...extra });

  it("moves the API twin's File, Partner and No-document Category onto the CSV row, keeping the origin", () => {
    const plan = planTwinMerge({
      api: api({ fileIds: ["f1"], partnerId: "p1", partnerType: "user", partnerMatchedBy: "manual", isComplete: true }),
      csv: csv(),
      records: [rec("f1", "a1", { origin: "mcp", connectionType: "api", matchConfidence: 0 })],
      files: new Map([["f1", file({ transactionIds: ["a1"] })]]),
      originals: new Map(),
    });
    expect(plan).toEqual({
      kind: "merge",
      apiId: "a1",
      csvId: "c1",
      moves: [{ fileId: "f1", origin: "mcp", connectionType: "api", matchConfidence: 0 }],
      unlinkOnly: [],
      partner: { partnerId: "p1", partnerType: "user", matchedBy: "manual" },
      category: null,
      quota: "decrement",
      notes: [],
    });
  });

  it("reads the origin of a record written before #612 from its connectionType", () => {
    const plan = planTwinMerge({
      api: api({ fileIds: ["f1", "f2", "f3"] }),
      csv: csv(),
      records: [
        rec("f1", "a1", { connectionType: "auto_matched", matchConfidence: 91, matchSources: ["amount"] }),
        rec("f2", "a1", { connectionType: "gmail_import", gmailIntegrationId: "g1", searchPattern: "invoice" }),
        rec("f3", "a1", { connectionType: "suggestion_accepted" }),
      ],
      files: new Map([["f1", file()], ["f2", file()], ["f3", file()]]),
      originals: new Map(),
    });
    expect(plan.kind === "merge" && plan.moves).toEqual([
      { fileId: "f1", origin: "auto", connectionType: "auto_matched", matchConfidence: 91, matchSources: ["amount"] },
      {
        fileId: "f2",
        origin: "manual",
        connectionType: "gmail_import",
        sourceInfo: { gmailIntegrationId: "g1", searchPattern: "invoice" },
      },
      { fileId: "f3", origin: "suggestion", connectionType: "suggestion_accepted" },
    ]);
  });

  it("only unlinks a File both twins hold", () => {
    const plan = planTwinMerge({
      api: api({ fileIds: ["f1"] }),
      csv: csv({ fileIds: ["f1"] }),
      records: [rec("f1", "a1", { origin: "manual" }), rec("f1", "c1", { origin: "manual" })],
      files: new Map([["f1", file({ transactionIds: ["a1", "c1"] })]]),
      originals: new Map(),
    });
    expect(plan).toMatchObject({ kind: "merge", moves: [], unlinkOnly: ["f1"] });
  });

  it("leaves a pair whose twins hold different Files for the User to decide", () => {
    const plan = planTwinMerge({
      api: api({ fileIds: ["f1"] }),
      csv: csv({ fileIds: ["f2"] }),
      records: [rec("f1", "a1", { origin: "manual" }), rec("f2", "c1", { origin: "manual" })],
      files: new Map([["f1", file()], ["f2", file()]]),
      originals: new Map(),
    });
    expect(plan).toEqual({ kind: "decision", apiId: "a1", csvId: "c1", reason: "different-files", apiFileIds: ["f1"], csvFileIds: ["f2"] });
  });

  it("leaves a pair for a decision when the twins name different Partners or Categories, or the CSV row rejected the File", () => {
    const base = { records: [], files: new Map(), originals: new Map() };
    expect(planTwinMerge({ ...base, api: api({ partnerId: "p1" }), csv: csv({ partnerId: "p2" }) })).toMatchObject({
      kind: "decision",
      reason: "different-partners",
    });
    expect(
      planTwinMerge({ ...base, api: api({ noReceiptCategoryId: "k1" }), csv: csv({ noReceiptCategoryId: "k2" }) })
    ).toMatchObject({ kind: "decision", reason: "different-categories" });
    expect(
      planTwinMerge({
        api: api({ fileIds: ["f1"] }),
        csv: csv({ rejectedFileIds: ["f1"], rejectedFiles: [{ fileId: "f1" }] }),
        records: [rec("f1", "a1", { origin: "manual" })],
        files: new Map([["f1", file()]]),
        originals: new Map(),
      })
    ).toMatchObject({ kind: "decision", reason: "rejected-on-csv", fileId: "f1" });
  });

  it("blocks a move the writer would refuse: a Copy, a File with no record, both twins over quota", () => {
    expect(
      planTwinMerge({
        api: api({ fileIds: ["f1"] }),
        csv: csv(),
        records: [rec("f1", "a1", { origin: "manual" })],
        files: new Map([["f1", file({ copyOfFileId: "f0" })]]),
        originals: new Map([["f0", { userId: "u" }]]),
      })
    ).toMatchObject({ kind: "blocked", reason: "copy", fileId: "f1" });
    expect(
      planTwinMerge({ api: api({ fileIds: ["f1"] }), csv: csv(), records: [], files: new Map([["f1", file()]]), originals: new Map() })
    ).toMatchObject({ kind: "blocked", reason: "no-record", fileId: "f1" });
    expect(
      planTwinMerge({
        api: api({ fileIds: ["f1"], quotaExceeded: true }),
        csv: csv({ quotaExceeded: true }),
        records: [rec("f1", "a1", { origin: "mcp" })],
        files: new Map([["f1", file()]]),
        originals: new Map(),
      })
    ).toMatchObject({ kind: "blocked", reason: "over-quota", fileId: "f1" });
  });

  it("gives the CSV row the API twin's quota slot when only the CSV row is over quota", () => {
    const plan = planTwinMerge({
      api: api(),
      csv: csv({ quotaExceeded: true }),
      records: [],
      files: new Map(),
      originals: new Map(),
    });
    expect(plan).toMatchObject({ kind: "merge", quota: "transfer" });
    expect(planTwinMerge({ api: api({ quotaExceeded: true }), csv: csv(), records: [], files: new Map(), originals: new Map() }))
      .toMatchObject({ kind: "merge", quota: "none" });
  });

  it("moves a No-document Category and notes a completion that rests on nothing", () => {
    expect(
      planTwinMerge({
        api: api({ noReceiptCategoryId: "k1", noReceiptCategoryMatchedBy: "auto", noReceiptCategoryConfidence: 88, isComplete: true }),
        csv: csv(),
        records: [],
        files: new Map(),
        originals: new Map(),
      })
    ).toMatchObject({ kind: "merge", category: { categoryId: "k1", matchedBy: "auto", confidence: 88 }, notes: [] });
    expect(
      planTwinMerge({ api: api({ isComplete: true }), csv: csv(), records: [], files: new Map(), originals: new Map() })
    ).toMatchObject({ kind: "merge", notes: ["api-complete-without-evidence"] });
  });
});
