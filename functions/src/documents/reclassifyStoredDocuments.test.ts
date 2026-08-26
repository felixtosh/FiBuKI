/**
 * The § 11 classifier's write path (#204).
 *
 * The invariants worth pinning are the safety ones: dry run by default, a
 * second run that writes nothing, no extraction field touched, and a dry run
 * whose reported distribution is the one the live run actually produces —
 * because the transaction pass reads the verdicts this run just computed
 * rather than the stale types still on the files.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  store,
  createMockFirestore,
  createTestFile,
  createTestTransaction,
} from "../test/setup";

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => createMockFirestore(),
}));

import { reclassifyStoredDocuments } from "./reclassifyStoredDocuments";

const userId = "test-user";

/** A Kleinbetragsrechnung: under 400 EUR with a printed rate is enough. */
function invoiceFile(overrides: Record<string, unknown> = {}) {
  return createTestFile({
    userId,
    extractedAmount: 5400,
    extractedVatPercent: 20,
    extractedDate: new Date("2026-03-04"),
    extractedIssuer: { name: "Elektro Huber e.U.", address: "Wien", vatId: null },
    extractedLineItems: [{ description: "USB-C Kabel", vatPercent: 20 }],
    extractedSelfDesignation: "Rechnung",
    extractedInvoiceNumber: null,
    ...overrides,
  });
}

/** A payment confirmation: no rate, no UID, and it says what it is. */
function receiptFile(overrides: Record<string, unknown> = {}) {
  return createTestFile({
    userId,
    extractedAmount: 2499,
    extractedDate: new Date("2026-03-05"),
    extractedIssuer: { name: "Amazon EU S.à r.l.", address: "Luxembourg", vatId: null },
    extractedSelfDesignation: "Zahlungsbestätigung",
    extractedInvoiceNumber: null,
    ...overrides,
  });
}

beforeEach(() => {
  store.clear();
});

describe("reclassifyStoredDocuments", () => {
  it("defaults to a dry run: it reports the distribution and writes nothing", async () => {
    store.setDoc("files", "f-invoice", invoiceFile());
    store.setDoc("files", "f-receipt", receiptFile());
    store.setDoc("files", "f-unknown", createTestFile({ userId, extractedAmount: null }));

    const result = await reclassifyStoredDocuments(userId);

    expect(result.dryRun).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.files).toMatchObject({
      scanned: 3,
      changed: 3,
      written: 0,
      degraded: 1,
    });
    expect(result.files.byType).toEqual({ invoice: 1, receipt: 1, other: 0, unknown: 1 });
    expect(result.files.byReason["section-11-satisfied"]).toBe(1);
    expect(result.files.byReason["receipt-designation"]).toBe(1);
    expect(result.files.byReason["no-gross-total"]).toBe(1);

    expect(store.getDoc("files", "f-invoice")?.documentType).toBeUndefined();
    expect(store.getDoc("files", "f-receipt")?.documentType).toBeUndefined();
  });

  it("persists the verdict and the basis when the live run is opted into", async () => {
    store.setDoc("files", "f-receipt", receiptFile());

    const result = await reclassifyStoredDocuments(userId, { dryRun: false });

    expect(result).toMatchObject({ dryRun: false, applied: true });
    expect(result.files.written).toBe(1);

    const file = store.getDoc("files", "f-receipt")!;
    expect(file.documentType).toBe("receipt");
    expect((file.documentTypeBasis as { reason: string }).reason).toBe("receipt-designation");
    expect(file.documentTypeMissingElements).toContain("steuersatz");
  });

  it("re-derives documentation state on every transaction, including one holding no files", async () => {
    store.setDoc("files", "f-invoice", invoiceFile());
    store.setDoc("files", "f-receipt", receiptFile());
    store.setDoc(
      "transactions",
      "tx-invoice",
      createTestTransaction({ userId, fileIds: ["f-invoice"] })
    );
    store.setDoc(
      "transactions",
      "tx-receipt",
      createTestTransaction({ userId, fileIds: ["f-receipt"] })
    );
    store.setDoc("transactions", "tx-bare", createTestTransaction({ userId, fileIds: [] }));
    store.setDoc(
      "transactions",
      "tx-category",
      createTestTransaction({ userId, fileIds: [], noReceiptCategoryId: "cat-1" })
    );

    const result = await reclassifyStoredDocuments(userId, { dryRun: false });

    expect(result.transactions).toMatchObject({ scanned: 4, changed: 4, written: 4 });
    expect(result.transactions.byState).toEqual({
      invoice: 1,
      "receipt-only": 1,
      "no-receipt-category": 1,
      undocumented: 1,
      unknown: 0,
    });
    expect(store.getDoc("transactions", "tx-invoice")?.documentationState).toBe("invoice");
    expect(store.getDoc("transactions", "tx-receipt")?.documentationState).toBe("receipt-only");
    expect(store.getDoc("transactions", "tx-bare")?.documentationState).toBe("undocumented");
    expect(store.getDoc("transactions", "tx-category")?.documentationState).toBe(
      "no-receipt-category"
    );
  });

  it("derives transaction state from the verdicts of this run, not the stale stored types", async () => {
    // The file still says `receipt` on disk; re-classifying makes it an
    // invoice. A dry run that read the stored type would report receipt-only
    // and describe a run nobody would get.
    store.setDoc("files", "f-1", invoiceFile({ documentType: "receipt" }));
    store.setDoc(
      "transactions",
      "tx-1",
      createTestTransaction({ userId, fileIds: ["f-1"], documentationState: "receipt-only" })
    );

    const dry = await reclassifyStoredDocuments(userId);
    expect(dry.transactions.byState.invoice).toBe(1);
    expect(dry.transactions.changed).toBe(1);
    expect(store.getDoc("transactions", "tx-1")?.documentationState).toBe("receipt-only");

    const live = await reclassifyStoredDocuments(userId, { dryRun: false });
    expect(live.transactions.written).toBe(1);
    expect(store.getDoc("transactions", "tx-1")?.documentationState).toBe("invoice");
  });

  it("writes only where the value moved, so a second run in a row writes nothing", async () => {
    store.setDoc("files", "f-invoice", invoiceFile());
    store.setDoc("files", "f-receipt", receiptFile());
    store.setDoc(
      "transactions",
      "tx-1",
      createTestTransaction({ userId, fileIds: ["f-invoice", "f-receipt"] })
    );

    const first = await reclassifyStoredDocuments(userId, { dryRun: false });
    expect(first.files.written).toBe(2);
    expect(first.transactions.written).toBe(1);

    const second = await reclassifyStoredDocuments(userId, { dryRun: false });
    expect(second.files).toMatchObject({ scanned: 2, changed: 0, written: 0 });
    expect(second.transactions).toMatchObject({ scanned: 1, changed: 0, written: 0 });
    expect(second.applied).toBe(false);
    // The corpus still reads the same — a no-op run is not a no-answer run.
    expect(second.files.byType).toEqual({ invoice: 1, receipt: 1, other: 0, unknown: 0 });
  });

  it("re-writes a file whose type is unchanged but whose basis moved", async () => {
    store.setDoc(
      "files",
      "f-1",
      invoiceFile({
        documentType: "invoice",
        documentTypeBasis: { reason: "legacy-record-undecidable", regime: null },
        documentTypeMissingElements: ["invoice-number"],
      })
    );

    const result = await reclassifyStoredDocuments(userId, { dryRun: false });

    expect(result.files.written).toBe(1);
    const basis = store.getDoc("files", "f-1")?.documentTypeBasis as { reason: string };
    expect(basis.reason).toBe("section-11-satisfied");
    expect(store.getDoc("files", "f-1")?.documentTypeMissingElements).toEqual([]);
  });

  it("never touches an extracted field, so a hand correction survives the sweep", async () => {
    const corrected = invoiceFile({
      extractedAmount: 31800,
      extractedVatAmount: 5300,
      extractedVatPercent: 20,
      extractionCorrectedAt: new Date("2026-08-01"),
    });
    store.setDoc("files", "f-1", corrected);

    await reclassifyStoredDocuments(userId, { dryRun: false });

    const after = store.getDoc("files", "f-1")!;
    for (const [key, value] of Object.entries(corrected)) {
      expect(after[key]).toEqual(value);
    }
  });

  it("ignores a file id that no longer resolves rather than parking the transaction in unknown", async () => {
    store.setDoc("files", "f-invoice", invoiceFile());
    store.setDoc(
      "transactions",
      "tx-1",
      createTestTransaction({ userId, fileIds: ["f-invoice", "f-deleted"] })
    );

    const result = await reclassifyStoredDocuments(userId, { dryRun: false });

    expect(result.transactions.byState.invoice).toBe(1);
    expect(store.getDoc("transactions", "tx-1")?.documentationState).toBe("invoice");
  });

  it("leaves another user's records alone", async () => {
    store.setDoc("files", "f-mine", receiptFile());
    store.setDoc("files", "f-theirs", receiptFile({ userId: "someone-else" }));
    store.setDoc(
      "transactions",
      "tx-theirs",
      createTestTransaction({ userId: "someone-else", fileIds: ["f-theirs"] })
    );

    const result = await reclassifyStoredDocuments(userId, { dryRun: false });

    expect(result.files.scanned).toBe(1);
    expect(result.transactions.scanned).toBe(0);
    expect(store.getDoc("files", "f-theirs")?.documentType).toBeUndefined();
    expect(store.getDoc("transactions", "tx-theirs")?.documentationState).toBeUndefined();
  });
  it("writes nothing at all when the transaction pass fails mid-sweep", async () => {
    store.setDoc("files", "f-receipt", receiptFile());
    store.setDoc(
      "transactions",
      "tx-1",
      createTestTransaction({ userId, fileIds: ["f-receipt"] })
    );

    // Both passes are planned before either is written, so a read that fails
    // leaves the corpus untouched. Committing the files first would leave the
    // file classified and its transaction still saying nothing — the split
    // this single call exists to prevent.
    const realGetCollection = store.getCollection.bind(store);
    const spy = vi
      .spyOn(store, "getCollection")
      .mockImplementation((name: string) => {
        if (name === "transactions") throw new Error("read failed mid-sweep");
        return realGetCollection(name);
      });

    await expect(reclassifyStoredDocuments(userId, { dryRun: false })).rejects.toThrow(
      "read failed mid-sweep"
    );

    spy.mockRestore();
    expect(store.getDoc("files", "f-receipt")?.documentType).toBeUndefined();
    expect(store.getDoc("transactions", "tx-1")?.documentationState).toBeUndefined();
  });
});
