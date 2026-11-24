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

/** The imports a CSV upload recorded (an `imports` record of the User and Bank Account). */
const CSV_IMPORTS = new Set([CSV]);

function row(id: string, importJobId: string | null, day: string, amount: number, name = "SHOP", currency = "EUR"): TwinRow {
  return { id, importJobId, day, amount, name, currency };
}
const pair = (rows: TwinRow[]) => pairTwins(rows, CSV_IMPORTS);

describe("which import a row came from", () => {
  it("knows the old MCP id format, a recorded CSV import and everything else", () => {
    expect(importKind("api_1750000000001", CSV_IMPORTS)).toBe("legacy-api");
    // The current tool id carries a random suffix and was deduplicated.
    expect(importKind("api_1750000000001_ab12cd34", CSV_IMPORTS)).toBe("other");
    expect(importKind(CSV, CSV_IMPORTS)).toBe("csv");
    // An id the MCP caller chose, or a bank sync: no CSV import recorded it.
    expect(importKind("cash_1", CSV_IMPORTS)).toBe("other");
    expect(importKind("sync_src_1755000000000", CSV_IMPORTS)).toBe("other");
    expect(importKind(null, CSV_IMPORTS)).toBe("other");
  });
});

describe("pairing API rows with their CSV twins", () => {
  it("pairs one API row with the one CSV row of the same day and amount", () => {
    const result = pair([
      row("a1", API_A, "2026-03-02", -1999),
      row("c1", CSV, "2026-03-02", -1999, "Shop GmbH"),
      row("c2", CSV, "2026-03-02", -500),
    ]);
    expect(result.pairs).toEqual([{ apiId: "a1", csvId: "c1" }]);
    expect(result.unmatched).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  it("reports an API row with no CSV twin, and never pairs across days or amounts", () => {
    const result = pair([
      row("a1", API_A, "2026-03-02", -1999),
      row("c1", CSV, "2026-03-03", -1999),
      row("c2", CSV, "2026-03-02", -2000),
    ]);
    expect(result.pairs).toEqual([]);
    expect(result.unmatched).toEqual(["a1"]);
  });

  it("pairs a day-and-amount group of several by name, and reports what the name does not settle", () => {
    const result = pair([
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
    const result = pair([
      row("a1", API_A, "2026-04-01", -1000, "X"),
      row("a2", API_B, "2026-04-01", -1000, "Y"),
      row("c1", CSV, "2026-04-01", -1000, "Z"),
    ]);
    expect(result.pairs).toEqual([]);
    expect(result.ambiguous).toEqual([{ apiIds: ["a1", "a2"], csvIds: ["c1"] }]);
  });

  it("never pairs a row without a finite amount, nor across currencies", () => {
    const result = pair([
      row("a1", API_A, "2026-03-02", NaN),
      row("c1", CSV, "2026-03-02", NaN),
      row("a2", API_A, "2026-03-03", -100, "X", "USD"),
      row("c2", CSV, "2026-03-03", -100, "X", "EUR"),
    ]);
    expect(result.pairs).toEqual([]);
    expect(result.unmatched).toEqual(["a2"]);
    expect(result.unpairable).toEqual(["a1"]);
  });

  it("ignores rows of other imports and API rows of the current id format", () => {
    const result = pair([
      row("a1", "api_1750000000001_ab12cd34", "2026-03-02", -1999),
      row("s1", "sync_src_1", "2026-03-02", -1999),
      row("m1", "cash_1", "2026-03-02", -1999),
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

  it("leaves a pair for a decision when the API twin holds work the CSV row lacks and nothing would move", () => {
    const base = { records: [], files: new Map(), originals: new Map() };
    for (const [field, value] of [
      ["rejectedFiles", [{ fileId: "f9" }]],
      ["receiptOnlyAcceptance", { acceptedAt: 1 }],
      ["partialPaymentAcceptance", { acceptedAt: 1 }],
      ["receiptLostEntry", { reason: "lost" }],
      ["vatRate", 20],
      ["isReverseCharge", true],
      ["foreignSupplyKind", "service"],
      ["reconciledByBankTxId", "t-x"],
    ] as const) {
      expect(planTwinMerge({ ...base, api: api({ [field]: value }), csv: csv() }), field).toMatchObject({
        kind: "decision",
        reason: "api-holds-state",
        fields: [field],
      });
    }
    // The same on both twins: nothing is lost.
    expect(planTwinMerge({ ...base, api: api({ vatRate: 20 }), csv: csv({ vatRate: 20 }) })).toMatchObject({ kind: "merge" });
    // Another row points at the API twin.
    expect(planTwinMerge({ ...base, api: api(), csv: csv(), referencedBy: ["t-cash"] })).toMatchObject({
      kind: "decision",
      reason: "referenced-by-other-rows",
    });
  });

  it("notes a description the API twin holds that the CSV row does not", () => {
    expect(
      planTwinMerge({ records: [], files: new Map(), originals: new Map(), api: api({ description: "office chair" }), csv: csv() })
    ).toMatchObject({ kind: "merge", notes: ["api-description-differs"] });
  });

  it("leaves the Partner for a decision when the User removed it from the CSV row", () => {
    expect(
      planTwinMerge({
        records: [],
        files: new Map(),
        originals: new Map(),
        api: api({ partnerId: "p1", partnerType: "user", partnerMatchedBy: "auto" }),
        csv: csv(),
        partners: new Map([["p1", { userId: "u", manualRemovals: [{ transactionId: "c1" }] }]]),
      })
    ).toMatchObject({ kind: "decision", reason: "partner-removed-on-csv" });
  });

  it("names what of the old record the writer does not keep", () => {
    const plan = planTwinMerge({
      api: api({ fileIds: ["f1", "f2"] }),
      csv: csv(),
      records: [
        rec("f1", "a1", { origin: "manual", connectionType: "manual", confirmedFrom: "auto_matched", confirmedAt: 1, createdAt: 1 }),
        rec("f2", "a1", { origin: "suggestion", connectionType: "suggestion_accepted", matchConfidence: 80 }),
      ],
      files: new Map([["f1", file()], ["f2", file()]]),
      originals: new Map(),
    });
    expect(plan.kind === "merge" && plan.moves.map((m) => m.dropped)).toEqual([
      ["createdAt", "confirmedFrom", "confirmedAt"],
      ["matchConfidence"],
    ]);
  });
});
