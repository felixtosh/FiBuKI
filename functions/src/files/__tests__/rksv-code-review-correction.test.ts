/**
 * The RKSV Code review flag and the Rate Groups' source on a hand correction
 * (#166).
 *
 * A correction of any VAT-bearing field clears the stored Rate Groups; their
 * source goes with them, and the flag that compared the printed block against
 * the code clears because no printed block is left. A correction that touches
 * no VAT field leaves all three as they were.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, createMockFirestore, createTestFile } from "../../test/setup";

vi.mock("firebase-admin/firestore", () => {
  class MockTimestamp {
    constructor(private readonly date: Date) {}
    static fromDate(d: Date) {
      return new MockTimestamp(d);
    }
    static now() {
      return new MockTimestamp(new Date("2026-08-26T12:00:00Z"));
    }
    toDate() {
      return this.date;
    }
    valueOf() {
      return this.date.getTime();
    }
  }

  return {
    getFirestore: () => createMockFirestore(),
    FieldValue: {
      serverTimestamp: () => new Date("2026-08-26T12:00:00Z"),
      arrayUnion: (...elements: unknown[]) => ({
        elements,
        constructor: { name: "ArrayUnionTransform" },
      }),
      arrayRemove: (...elements: unknown[]) => ({
        elements,
        constructor: { name: "ArrayRemoveTransform" },
      }),
      increment: (n: number) => n,
      delete: () => ({ constructor: { name: "DeleteTransform" } }),
    },
    Timestamp: MockTimestamp,
  };
});

// The MCP door imports the extraction path for its own retry tool; no test
// here reaches the model, but the module must not be the real one.
vi.mock("../../extraction/extractionCore", () => ({ runExtraction: vi.fn() }));
vi.mock("firebase-functions/params", () => ({
  defineSecret: (name: string) => ({ value: () => `test-${name}` }),
}));

const { updateFileExtraction } = await import("../../tools/handlers");
const { decideFactChange } = await import("../../fileFacts/factChange");

const userId = "user-1";

const CODE = "_R1-AT1_K1_42_2026-05-02T10:00:00_0,00_11,60_11,00_0,00_0,00_x_y_z_sig";

function seed() {
  store.clear();
  store.setDoc(
    "files",
    "f-1",
    createTestFile({
      userId,
      fileName: "billa.jpg",
      extractionComplete: true,
      extractedAmount: 2260,
      extractedCurrency: "EUR",
      extractedQrCodes: [{ format: "rksv", payload: CODE }],
      // The model transposed the 10 % and 13 % rows.
      extractedRateGroups: [
        { rate: 10, net: 1000, vat: 100, gross: 1100 },
        { rate: 13, net: 1027, vat: 133, gross: 1160 },
      ],
      extractedRateGroupsSource: "document",
      needsRksvCodeReview: true,
      rksvCodeDisagreeingRates: [10, 13],
      invoiceDirection: "incoming",
    })
  );
}

const file = () => store.getDoc("files", "f-1") as Record<string, unknown>;

beforeEach(() => seed());

describe("a correction and the RKSV Code review (#166)", () => {
  it("clears the Rate Groups, their source and the flag on a VAT-bearing correction", async () => {
    await updateFileExtraction(userId, { fileId: "f-1", vatAmount: 227 });

    expect(file().extractedRateGroups).toBeNull();
    expect(file().extractedRateGroupsSource).toBeNull();
    expect(file().needsRksvCodeReview).toBe(false);
    expect(file().rksvCodeDisagreeingRates).toEqual([]);
  });

  it("leaves all three as they were on a correction that touches no VAT field", async () => {
    await updateFileExtraction(userId, { fileId: "f-1", date: "2026-05-03" });

    expect(file().extractedRateGroupsSource).toBe("document");
    expect(file().needsRksvCodeReview).toBe(true);
    expect(file().rksvCodeDisagreeingRates).toEqual([10, 13]);
  });
});

describe("marking a File not an invoice (#166)", () => {
  it("clears the source and the flag with the Rate Groups", () => {
    const outcome = decideFactChange(
      { record: {}, linkedTransactions: [] },
      { origin: "not-invoice" }
    );
    if (outcome.refused) throw new Error(outcome.message);
    const updates = outcome.update;

    expect(updates.extractedRateGroups).toBeNull();
    expect(updates.extractedRateGroupsSource).toBeNull();
    expect(updates.needsRksvCodeReview).toBe(false);
    expect(updates.rksvCodeDisagreeingRates).toEqual([]);
  });
});
