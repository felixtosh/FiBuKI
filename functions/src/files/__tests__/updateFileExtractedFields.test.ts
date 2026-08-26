/**
 * The UI's correction callable (#149).
 *
 * Before this existed the file detail panel wrote the extracted record straight
 * to Firestore, so a correction typed by a person left no provenance and the
 * next `retry_file_extraction` re-rolled the model over it — while the same
 * correction made through the MCP tool was protected. The callable closes that
 * by routing the panel's save through the same builder the tool uses.
 *
 * The panel posts the whole record on every save, so the interesting half is
 * what it does *not* stamp: a save that typed nothing must leave the file
 * un-corrected, or opening the panel would freeze the file against
 * re-extraction forever.
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
    },
    Timestamp: MockTimestamp,
  };
});

// The retry path is imported for the round trip below; its extraction run is
// never reached, because the refusal this test is about fires before it.
vi.mock("../../extraction/extractionCore", () => ({ runExtraction: vi.fn() }));

const { updateFileExtractedFieldsCallable } = await import("../updateFileExtractedFields");
const { retryExtractionForFile } = await import("../../extraction/retryExtractionOps");
const { getFirestore } = await import("firebase-admin/firestore");

const userId = "user-1";

function call(data: Record<string, unknown>) {
  return (updateFileExtractedFieldsCallable as unknown as {
    run: (r: never) => Promise<{ changed: string[]; correctedFields: string[] }>;
  }).run({ data, auth: { uid: userId } } as never);
}

const ITEM = {
  description: "Consulting",
  quantity: 1,
  unitPrice: 265000,
  vatPercent: 20,
  vatAmount: 53000,
  amount: 265000,
};

/** What the panel posts for a file nobody has edited. */
function unchangedSave(overrides: Record<string, unknown> = {}) {
  return {
    fileId: "f-1",
    correction: {
      amount: 318000,
      vatAmount: 53000,
      vatPercent: 20,
      date: "2026-03-04",
      lineItems: [ITEM],
      ...(overrides.correction as Record<string, unknown> | undefined),
    },
    details: {
      partner: "ACME GmbH",
      vatId: "ATU12345678",
      iban: null,
      address: null,
      additionalFields: null,
      ...(overrides.details as Record<string, unknown> | undefined),
    },
  };
}

function seedFile(overrides: Record<string, unknown> = {}) {
  store.setDoc(
    "files",
    "f-1",
    createTestFile({
      userId,
      extractedAmount: 318000,
      extractedVatAmount: 53000,
      extractedVatPercent: 20,
      extractedDate: { toDate: () => new Date("2026-03-04T00:00:00Z") },
      extractedLineItems: [ITEM],
      extractedPartner: "ACME GmbH",
      extractedVatId: "ATU12345678",
      ...overrides,
    })
  );
}

const file = () => store.getDoc("files", "f-1") as Record<string, unknown>;

beforeEach(() => {
  store.clear();
});

describe("updateFileExtractedFieldsCallable", () => {
  it("does not mark a file hand-corrected when the save typed nothing", async () => {
    seedFile();

    const result = await call(unchangedSave());

    expect(result.changed).toEqual([]);
    expect(file().extractionCorrectedFields).toBeUndefined();
    expect(file().extractionCorrectedAt).toBeUndefined();
  });

  it("stamps the field a person actually re-keyed, and only that one", async () => {
    seedFile();

    const result = await call(unchangedSave({ correction: { amount: 636000 } }));

    expect(result.changed).toEqual(["amount"]);
    expect(file().extractedAmount).toBe(636000);
    expect(Object.keys(file().extractionCorrectedFields as object)).toEqual(["amount"]);
    expect(file().extractionCorrectedAt).toBeDefined();
    expect(result.correctedFields).toEqual(["amount"]);
  });

  it("keeps the marks earlier corrections left", async () => {
    const earlier = { toDate: () => new Date("2026-01-01T00:00:00Z") };
    seedFile({ extractionCorrectedFields: { vatPercent: earlier } });

    await call(unchangedSave({ correction: { amount: 636000 } }));

    expect(Object.keys(file().extractionCorrectedFields as object).sort()).toEqual([
      "amount",
      "vatPercent",
    ]);
  });

  it("clears the artefacts that would outrank the person on a VAT-bearing fix", async () => {
    seedFile({
      lineItemsUnreconciled: true,
      extractedRateGroups: [{ vatPercent: 20, net: 265000, vat: 53000 }],
      vatSourceDowngraded: true,
    });

    await call(unchangedSave({ correction: { vatPercent: 10 } }));

    expect(file().lineItemsUnreconciled).toBe(false);
    expect(file().extractedRateGroups).toBeNull();
    expect(file().vatSourceDowngraded).toBe(false);
  });

  it("still lifts the review flags when a person saves rows they left as they were", async () => {
    // The panel did this before it delegated (fork #64/#67): having the
    // itemisation in front of you and saving settles the file. It is an
    // acknowledgement rather than a correction, so no stamp goes with it —
    // otherwise re-extraction would refuse a file nobody actually re-keyed.
    seedFile({ lineItemsUnreconciled: true, vatSourceDowngraded: true });

    const result = await call(unchangedSave());

    expect(file().lineItemsUnreconciled).toBe(false);
    expect(file().vatSourceDowngraded).toBe(false);
    expect(result.changed).toEqual([]);
    expect(file().extractionCorrectedFields).toBeUndefined();
  });

  it("writes the descriptive fields whether or not anything was corrected", async () => {
    seedFile();

    await call(unchangedSave({ details: { partner: "ACME AG", iban: "AT611904300234573201" } }));

    expect(file().extractedPartner).toBe("ACME AG");
    expect(file().extractedIban).toBe("AT611904300234573201");
    // Those are not correctable fields: renaming the counterparty is not a
    // ruling on the figures, so it stamps nothing.
    expect(file().extractionCorrectedFields).toBeUndefined();
  });

  it("takes the descriptive boxes as text and nothing else", async () => {
    seedFile();

    await expect(
      call(unchangedSave({ details: { partner: { name: "ACME" } } }))
    ).rejects.toThrow(/must be a string/);

    // A junk row inside an otherwise fine list is dropped, not stored.
    await call(
      unchangedSave({
        details: { additionalFields: [{ label: "Nr", value: "R-1" }, { label: 7, value: null }] },
      })
    );
    expect(file().extractedAdditionalFields).toEqual([
      { label: "Nr", value: "R-1", rawValue: "R-1" },
    ]);
  });

  it("refuses a value the builder cannot read instead of writing it", async () => {
    seedFile();

    await expect(call(unchangedSave({ correction: { date: "04.03.2026" } }))).rejects.toThrow(
      /ISO date/
    );
    expect(file().extractedPartner).toBe("ACME GmbH");
  });

  it("refuses a file owned by someone else", async () => {
    store.setDoc("files", "f-1", createTestFile({ userId: "someone-else" }));

    await expect(call(unchangedSave())).rejects.toThrow(/not found|denied/i);
  });

  it("makes re-extraction refuse the file, which is the point of the stamp", async () => {
    // The acceptance criterion for #149 is a round trip, not a field write: a
    // correction typed in the panel has to stop the next sweep the same way an
    // agent's correction does.
    seedFile({ extractionComplete: true, extractionError: null });

    await call(unchangedSave({ correction: { amount: 636000 } }));

    await expect(
      retryExtractionForFile(getFirestore(), { fileId: "f-1", userId, force: true })
    ).rejects.toThrow(/hand corrections/i);
  });

  it("requires a fileId", async () => {
    await expect(call({ correction: {}, details: {} })).rejects.toThrow(/fileId/);
  });
});
