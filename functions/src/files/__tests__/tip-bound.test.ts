/**
 * #310: the bound on a hand-set Trinkgeld, through both correction doors.
 *
 * #217 gave `extractedTipAmount` a writer and left it unbounded. The damage a
 * wrong figure does there is not VAT — a tip is outside the scope of it, and
 * nothing subtracts it from `extractedAmount` — it is matching: 600,00 typed
 * into the tip box of a 40,00 Beleg moves the reconciled total off every bank
 * line there is, and the file becomes unmatchable with nothing on the record
 * saying why.
 *
 * A tip the document PRINTS is inside the document total, so that total
 * bounds it. A tip it never printed sits on top of it, and the document has
 * nothing to say about how large it can be. #310 measured that one against the
 * bank line; #554 took that out, because it judged a document fact by a
 * matching fact. A correction now checks only what the document shows, and
 * the UVA decides what an uncovered tip means (`tip-partial-payment`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, createMockFirestore, createTestFile, createTestTransaction } from "../../test/setup";

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

const { checkTipBound } = await import("../tipBound");
const { updateFileExtractedFieldsCallable } = await import("../updateFileExtractedFields");
const { updateFileExtraction } = await import("../../tools/handlers");

const userId = "user-1";

/**
 * Kaffeehaus Sperl. A 3,00 Melange, and a card charge of 8,00 because the
 * terminal took 5,00 on top of it — a tip larger than the document total and
 * perfectly ordinary. It is the case the document bound cannot accept, and
 * the reason a tip can be declared as not printed.
 */
const DOCUMENT_TOTAL = 300;
const CARD_CHARGE = 800;
const TIP = 500;

function seed(file: Record<string, unknown> = {}, transaction: Record<string, unknown> | null = {}) {
  store.clear();
  store.setDoc(
    "files",
    "f-1",
    createTestFile({
      userId,
      fileName: "kaffeehaus-sperl.pdf",
      extractionComplete: true,
      extractedAmount: DOCUMENT_TOTAL,
      extractedTipAmount: null,
      extractedCurrency: "EUR",
      extractedVatPercent: 10,
      extractedPartner: "Kaffeehaus Sperl",
      invoiceDirection: "incoming",
      transactionIds: transaction === null ? [] : ["tx-1"],
      ...file,
    })
  );

  if (transaction !== null) {
    store.setDoc(
      "transactions",
      "tx-1",
      createTestTransaction({
        userId,
        amount: -CARD_CHARGE,
        name: "KAFFEEHAUS SPERL WIEN",
        fileIds: ["f-1"],
        ...transaction,
      })
    );
  }
}

const file = () => store.getDoc("files", "f-1") as Record<string, unknown>;

/** The panel door. It posts the whole extracted record on every save. */
function panel(correction: Record<string, unknown>, tipNotPrinted?: boolean) {
  return (updateFileExtractedFieldsCallable as unknown as {
    run: (r: never) => Promise<{ changed: string[] }>;
  }).run({
    data: {
      fileId: "f-1",
      correction: { amount: DOCUMENT_TOTAL, ...correction },
      ...(tipNotPrinted === undefined ? {} : { tipNotPrinted }),
    },
    auth: { uid: userId },
  } as never);
}

/** The MCP door. It names the fields it means. */
function mcp(args: Record<string, unknown>) {
  return updateFileExtraction(userId, { fileId: "f-1", ...args });
}

beforeEach(() => seed());

describe("the bound itself", () => {
  it("measures a tip against the document total by default", () => {
    expect(
      checkTipBound({ tip: 320, documentTotal: 5080, notPrinted: false })
    ).toEqual({ bound: "document", total: 5080 });
  });

  it("does not measure a tip declared as not printed against anything", () => {
    expect(
      checkTipBound({ tip: TIP, documentTotal: DOCUMENT_TOTAL, notPrinted: true })
    ).toEqual({ bound: "not-printed" });
    // Not even against a missing document total: the declaration says the
    // document does not hold the tip.
    expect(checkTipBound({ tip: TIP, documentTotal: null, notPrinted: true })).toEqual({
      bound: "not-printed",
    });
  });

  it("takes the total in absolute value: a credit note bounds a tip as its own total", () => {
    expect(
      checkTipBound({ tip: 320, documentTotal: -5080, notPrinted: false })
    ).toEqual({ bound: "document", total: 5080 });
  });

  it("returns no bound for no tip, so clearing one clears what bounded it", () => {
    expect(checkTipBound({ tip: null, documentTotal: 5080, notPrinted: false })).toBeNull();
    expect(checkTipBound({ tip: 0, documentTotal: 5080, notPrinted: false })).toBeNull();
  });

  it("refuses a tip that is not less than the total it is measured against", () => {
    // The boundary is the one uva/tip.ts draws (#317): a tip equal to the
    // payment is a Gesamt in the Trinkgeld field, and it leaves nothing for the
    // document's own rates to apply to.
    expect(() =>
      checkTipBound({ tip: 5080, documentTotal: 5080, notPrinted: false })
    ).toThrow(/must be less than the document total/);
  });
});

describe("the document bound, by default", () => {
  it("refuses an oversized tip and names the total it was measured against", async () => {
    // The ticket's own walk, in miniature: 600,00 typed into the tip box of a
    // document that totals 3,00. Nothing downstream would ever catch it — the
    // file would simply stop matching.
    await expect(panel({ tipAmount: 60000 })).rejects.toThrow(
      "tipAmount 600.00 must be less than the document total it is measured against, 3.00."
    );
    await expect(mcp({ tipAmount: 60000 })).rejects.toThrow(
      "tipAmount 600.00 must be less than the document total it is measured against, 3.00."
    );
  });

  it("names the way out, because an outsized tip is usually an unprinted one", async () => {
    await expect(mcp({ tipAmount: TIP })).rejects.toThrow(/declare it as not printed/);
  });

  it("refuses rather than clamps: nothing is written", async () => {
    await expect(mcp({ tipAmount: 60000 })).rejects.toThrow();

    expect(file().extractedTipAmount).toBeNull();
    expect(file().extractedAmount).toBe(DOCUMENT_TOTAL);
    expect(file().extractionCorrectedFields).toBeUndefined();
  });

  it("accepts a tip inside the document total, unchanged, and leaves the total alone", async () => {
    // The #217 shape: 50,80 on the Beleg, 3,20 taken by the terminal. It fits
    // inside the document total, so the default bound has nothing to say —
    // and `extractedAmount` is still not reduced by the tip, which is THE trap
    // of that ticket.
    seed({ extractedAmount: 5080 }, { amount: -5400 });

    const result = await panel({ amount: 5080, tipAmount: 320 });

    expect(result.changed).toEqual(["tipAmount"]);
    expect(file().extractedTipAmount).toBe(320);
    expect(file().extractedAmount).toBe(5080);
    expect(file().extractedTipBound).toEqual({ bound: "document", total: 5080 });
  });

  it("is not applied to a correction that leaves the tip alone", async () => {
    // A file that acquired an oversized tip before this guard existed has to
    // stay repairable through every other field.
    seed({ extractedTipAmount: 60000 });

    await mcp({ vatPercent: 20 });

    expect(file().extractedVatPercent).toBe(20);
    expect(file().extractedTipAmount).toBe(60000);
  });

  it("refuses a tip on a file with no document total, naming what is missing", async () => {
    seed({ extractedAmount: null });

    await expect(mcp({ tipAmount: 320 })).rejects.toThrow(
      /measured against the document total and this file has none/
    );
  });
});

describe("a tip declared as not printed (#554)", () => {
  it("accepts a tip larger than the document total but smaller than the bank line", async () => {
    // 5,00 on a 3,00 Melange: impossible against the document, ordinary
    // against the 8,00 the card was actually charged.
    const result = await panel({ tipAmount: TIP }, true);

    expect(result.changed).toEqual(["tipAmount"]);
    expect(file().extractedTipAmount).toBe(TIP);
    expect(file().extractedAmount).toBe(DOCUMENT_TOTAL);
  });

  it("records the declaration, so an unprinted tip is legible as one", async () => {
    await mcp({ tipAmount: TIP, tipNotPrinted: true });

    expect(file().extractedTipBound).toEqual({ bound: "not-printed" });
  });

  it("is not measured against the bank line, on either door", async () => {
    // #310 refused this: 600,00 is not less than the 8,00 card charge. A
    // correction no longer reads the bank line. The UVA puts the transaction
    // on review instead (`impossible-tip`, since 600,00 is not less than
    // 8,00), which is where a figure that does not reconcile is judged.
    await panel({ tipAmount: 60000 }, true);
    expect(file().extractedTipAmount).toBe(60000);

    seed();
    await mcp({ tipAmount: 60000, tipNotPrinted: true });
    expect(file().extractedTipAmount).toBe(60000);
    expect(file().extractedTipBound).toEqual({ bound: "not-printed" });
  });

  it("accepts the arithmetically short tip #346 was filed about", async () => {
    // 3,00 + 7,99 is not the 8,00 that was paid. The document cannot show
    // that, so the correction takes it; the UVA lists the transaction as
    // `tip-partial-payment` and claims nothing until someone rules on it.
    await mcp({ tipAmount: 799, tipNotPrinted: true });

    expect(file().extractedTipAmount).toBe(799);
  });

  it("does not need the file to be connected to a transaction", async () => {
    seed({}, null);

    await mcp({ tipAmount: TIP, tipNotPrinted: true });

    expect(file().extractedTipAmount).toBe(TIP);
    expect(file().extractedTipBound).toEqual({ bound: "not-printed" });
  });

  it("does not need a document total", async () => {
    seed({ extractedAmount: null });

    await panel({ amount: null, tipAmount: TIP }, true);

    expect(file().extractedTipAmount).toBe(TIP);
  });

  it("clears the recorded declaration when the tip is cleared", async () => {
    await mcp({ tipAmount: TIP, tipNotPrinted: true });
    expect(file().extractedTipBound).toEqual({ bound: "not-printed" });

    await mcp({ tipAmount: null });

    expect(file().extractedTipAmount).toBeNull();
    expect(file().extractedTipBound).toBeNull();
  });

  it("is a property of the correction, not a stamp on the record", async () => {
    // It says how to read the tip in this call. The field a person ruled on is
    // still `tipAmount`, and that is what re-extraction refuses on (#184).
    await mcp({ tipAmount: TIP, tipNotPrinted: true });

    expect(Object.keys(file().extractionCorrectedFields as object)).toEqual(["tipAmount"]);
  });

  it("refuses a declaration that is not a boolean", async () => {
    await expect(mcp({ tipAmount: TIP, tipNotPrinted: "yes" })).rejects.toThrow(
      /tipNotPrinted must be a boolean/
    );
  });
});

describe("the total the bound is measured against", () => {
  // `buildCorrectedFileUpdate` measures the record as it will be AFTER this
  // write, which matters because the two figures move together: the reason a
  // tip does not fit is often that the total beside it is the one that is
  // wrong, and correcting both in one call is the ordinary repair.

  it("is the one this correction leaves, not the one on the record", async () => {
    // 600,00 against a stored total of 3,00 is refused above; raising the
    // total in the same call is what makes it a 600,00 tip on a 1.000,00 bill.
    await mcp({ amount: 100000, tipAmount: 60000 });

    expect(file().extractedTipAmount).toBe(60000);
    expect(file().extractedTipBound).toEqual({ bound: "document", total: 100000 });
  });

  it("refuses against the corrected total when the same call lowers it", async () => {
    seed({ extractedAmount: 100000 });

    await expect(mcp({ amount: 300, tipAmount: 500 })).rejects.toThrow(
      "tipAmount 5.00 must be less than the document total it is measured against, 3.00."
    );

    expect(file().extractedAmount).toBe(100000);
    expect(file().extractedTipAmount).toBeNull();
  });
});
