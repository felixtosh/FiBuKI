/**
 * The BMD export hands the UVA adapter every Transaction field the adapter
 * reads (#715).
 *
 * `vatRowsFor` builds the Transaction it passes to `buildUvaTransaction` by
 * hand. #652 was the File side of this pattern: a hand-written field list fell
 * behind what the adapter reads, and the export stated different VAT from the
 * UVA without any test noticing, because the agreement suite feeds fixtures
 * straight into the generators. #697 loads the stored File instead; the
 * Transaction keeps its list (it maps `partnerName` onto `partner`), so this
 * guards it.
 *
 * The adapter runs on a Proxy over what the export passed, recording every
 * field it reads. A read of a field the export did not pass fails here: that
 * field would be missing from every export, silently.
 *
 * The shapes below walk every branch of the adapter that reads a Transaction
 * field (purchase and sale, a no-receipt category without a template, a
 * Partner, an Accepted Partial Payment ruling, a linked correction). A new
 * read on a branch none of them reaches needs a shape here too.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Timestamp } from "./firestore-shim";
import type * as Adapter from "../uva/adapter";

const calls: Array<{ passed: Set<string>; read: Set<string> }> = [];

vi.mock("../uva/adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof Adapter>();
  return {
    ...actual,
    buildUvaTransaction: (tx: Adapter.TransactionRecord, opts: Adapter.BuildOptions) => {
      const read = new Set<string>();
      const record = (key: string | symbol) => {
        if (typeof key === "string") read.add(key);
      };
      const watched = new Proxy(tx, {
        get(target, key, receiver) {
          record(key);
          return Reflect.get(target, key, receiver);
        },
        has(target, key) {
          record(key);
          return Reflect.has(target, key);
        },
        getOwnPropertyDescriptor(target, key) {
          record(key);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
      const out = actual.buildUvaTransaction(watched, opts);
      calls.push({ passed: new Set(Object.keys(tx)), read });
      return out;
    },
  };
});

import {
  generateBuchungenCsvWithReport,
  type FileForExport,
  type TransactionForExport,
} from "../bmd-export/bmdCsvGenerators";

const DATE = Timestamp.fromDate(new Date("2026-03-15T12:00:00Z"));

const invoice: FileForExport = {
  id: "f1",
  fileName: "beleg.pdf",
  extractedAmount: 12000,
  extractedVatAmount: 2000,
  extractedVatPercent: 20,
};

const SHAPES: Array<{ name: string; tx: TransactionForExport; files?: FileForExport[] }> = [
  { name: "a purchase with an invoice", tx: { id: "t", date: DATE, amount: -12000, fileIds: ["f1"] }, files: [invoice] },
  {
    name: "a purchase flagged reverse charge, answered as goods",
    tx: { id: "t", date: DATE, amount: -12000, fileIds: ["f1"], isReverseCharge: true, foreignSupplyKind: "goods" },
    files: [invoice],
  },
  {
    name: "a sale to a Partner, answered by the person",
    tx: {
      id: "t",
      date: DATE,
      amount: 12000,
      fileIds: ["f1"],
      partnerId: "p1",
      partnerName: "Kunde GmbH",
      partnerCountry: "DE",
      saleSupplyKind: "service-eu",
    },
    files: [invoice],
  },
  {
    name: "a no-receipt category with no template on the Transaction",
    tx: { id: "t", date: DATE, amount: -500, noReceiptCategoryId: "c1" },
  },
  {
    name: "a no-receipt category with its template",
    tx: { id: "t", date: DATE, amount: -500, noReceiptCategoryId: "c1", noReceiptCategoryTemplateId: "bank-fees" },
  },
  {
    name: "an Accepted Partial Payment that is still live",
    tx: {
      id: "t",
      date: DATE,
      amount: -6000,
      fileIds: ["f1"],
      partialPaymentAcceptance: {
        bankAmount: -6000,
        files: [{ id: "f1", total: 12000, tip: null }],
        by: "u",
        at: null,
        reason: "split bill",
      },
    },
    files: [invoice],
  },
  {
    name: "a linked refund",
    tx: {
      id: "t",
      date: DATE,
      amount: 12000,
      fileIds: ["f1"],
      correction: {
        status: "linked",
        kind: "purchase",
        basis: "link",
        original: {
          fileId: "f-original",
          paidByTransactionIds: ["t-original"],
          gross: 12000,
          claimed: [{ rate: 20, net: 10000, vat: 2000 }],
        },
        priorCorrected: [],
      },
    },
    files: [invoice],
  },
];

beforeEach(() => {
  calls.length = 0;
});

describe("bmd #715: the export passes every Transaction field the UVA adapter reads", () => {
  it.each(SHAPES)("$name", ({ tx, files = [] }) => {
    generateBuchungenCsvWithReport([tx], new Map(files.map((f) => [f.id, f])), new Map());

    // The export reached the adapter, or this proves nothing.
    expect(calls).toHaveLength(1);
    const { passed, read } = calls[0];
    expect(read).toContain("amount");

    const missing = [...read].filter((key) => !passed.has(key));
    expect(missing, "the UVA adapter reads these Transaction fields; vatRowsFor must pass them").toEqual([]);
  });
});
