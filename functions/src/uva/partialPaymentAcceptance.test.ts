/**
 * Accepted Partial Payment (#554): the ruling is live exactly while the
 * figures it was made over are the ones on the record.
 */

import { describe, it, expect } from "vitest";
import {
  isPartialPaymentAcceptanceLive,
  partialPaymentFigures,
  type PartialPaymentAcceptance,
  type RuledFileRecord,
} from "./partialPaymentAcceptance";
import { buildUvaTransaction, type FileRecord } from "./adapter";

/** A split bill: 100,00 + 10,00 tip, 55,00 paid. */
const files = (overrides: Partial<RuledFileRecord> = {}) =>
  new Map<string, RuledFileRecord>([
    ["f-1", { extractedAmount: 10000, extractedTipAmount: 1000, ...overrides }],
  ]);

const ruling = (over: Partial<PartialPaymentAcceptance> = {}): PartialPaymentAcceptance => ({
  by: "user-1",
  at: null,
  reason: "Split the bill",
  bankAmount: -5500,
  files: [{ id: "f-1", total: 10000, tip: 1000 }],
  ...over,
});

const tx = (over: Record<string, unknown> = {}) => ({
  amount: -5500,
  fileIds: ["f-1"],
  partialPaymentAcceptance: ruling(),
  ...over,
});

describe("partialPaymentFigures", () => {
  it("records the bank amount and each file's total and tip", () => {
    expect(partialPaymentFigures({ amount: -5500, fileIds: ["f-1"] }, files())).toEqual({
      bankAmount: -5500,
      files: [{ id: "f-1", total: 10000, tip: 1000 }],
    });
  });

  it("reads a tip of zero as no tip", () => {
    expect(
      partialPaymentFigures({ amount: -5500, fileIds: ["f-1"] }, files({ extractedTipAmount: 0 }))
        .files[0].tip
    ).toBeNull();
  });

  it("keeps a file it cannot read, with no figures", () => {
    expect(partialPaymentFigures({ amount: -5500, fileIds: ["f-gone"] }, files()).files).toEqual([
      { id: "f-gone", total: null, tip: null },
    ]);
  });
});

describe("isPartialPaymentAcceptanceLive", () => {
  it("is live over the figures it was made over", () => {
    expect(isPartialPaymentAcceptanceLive(tx(), files())).toBe(true);
  });

  it("is not live without a ruling, or after a revoke", () => {
    expect(isPartialPaymentAcceptanceLive(tx({ partialPaymentAcceptance: undefined }), files())).toBe(false);
    expect(isPartialPaymentAcceptanceLive(tx({ partialPaymentAcceptance: null }), files())).toBe(false);
  });

  it("goes stale when the bank amount changes", () => {
    expect(isPartialPaymentAcceptanceLive(tx({ amount: -5600 }), files())).toBe(false);
  });

  it("goes stale when a file's tip changes", () => {
    expect(isPartialPaymentAcceptanceLive(tx(), files({ extractedTipAmount: 1200 }))).toBe(false);
    expect(isPartialPaymentAcceptanceLive(tx(), files({ extractedTipAmount: null }))).toBe(false);
  });

  it("goes stale when a file's total changes", () => {
    expect(isPartialPaymentAcceptanceLive(tx(), files({ extractedAmount: 9000 }))).toBe(false);
  });

  it("goes stale when a file is added or removed", () => {
    const more = files();
    more.set("f-2", { extractedAmount: 500 });
    expect(isPartialPaymentAcceptanceLive(tx({ fileIds: ["f-1", "f-2"] }), more)).toBe(false);
    expect(isPartialPaymentAcceptanceLive(tx({ fileIds: [] }), files())).toBe(false);
  });

  it("does not care about the order of the files", () => {
    const two = new Map<string, RuledFileRecord>([
      ["f-1", { extractedAmount: 10000, extractedTipAmount: 1000 }],
      ["f-2", { extractedAmount: 500 }],
    ]);
    const ruled = ruling({
      files: [
        { id: "f-2", total: 500, tip: null },
        { id: "f-1", total: 10000, tip: 1000 },
      ],
    });
    expect(
      isPartialPaymentAcceptanceLive(
        { amount: -5500, fileIds: ["f-1", "f-2"], partialPaymentAcceptance: ruled },
        two
      )
    ).toBe(true);
  });
});

describe("the adapter reads the ruling only through liveness", () => {
  const record = (over: Record<string, unknown> = {}) => ({
    id: "tx-1",
    date: { toDate: () => new Date("2026-02-20T00:00:00Z") },
    ...tx(over),
  });
  const filesById = (tip: number) =>
    new Map<string, FileRecord>([
      ["f-1", { id: "f-1", extractedAmount: 10000, extractedTipAmount: tip }],
    ]);
  const build = (over: Record<string, unknown>, tip = 1000) =>
    buildUvaTransaction(record(over), { filesById: filesById(tip), categoriesById: new Map() });

  it("passes a live ruling to the ladder", () => {
    expect(build({}).partialPaymentAccepted).toBe(true);
  });

  it("passes a stale one as no ruling", () => {
    expect(build({}, 1200).partialPaymentAccepted).toBe(false);
    expect(build({ partialPaymentAcceptance: null }).partialPaymentAccepted).toBe(false);
  });
});
