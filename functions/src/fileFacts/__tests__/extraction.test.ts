/**
 * The File facts module at its interface, for an Extraction (#639).
 *
 * Each case gives the module a File and an Extraction's reading and reads the
 * outcome: the complete File update, the follow-ups, or the refusal. No
 * database. What the Extraction itself reads off a document is pinned by the
 * Extraction characterization suite (`selfhost/extraction-characterization`);
 * these pin what the module does with the reading: the refusal on a Hand
 * Correction, the forced overwrite, the Due Date and Debit Date (cleared when
 * the reading has no row), the cleared facts of a not-invoice reading, the
 * derived fields and the follow-ups.
 *
 *   npx vitest run src/fileFacts/__tests__/extraction.test.ts --pool=forks --maxWorkers=1
 */

import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { decideFactChange, isHandCorrectionWrite, type FactOutcome } from "../factChange";
import type { ExtractedFacts, ExtractionReading } from "../extractionReading";

const AT = Timestamp.fromDate(new Date("2026-09-01T10:00:00Z"));

/** A stored date: UTC midnight of the calendar day, as every writer stores it. */
const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));
const isoOf = (value: unknown) =>
  value instanceof Timestamp ? value.toDate().toISOString().slice(0, 10) : value;

const entity = (name: string) => ({ name, vatId: null, address: null, iban: null, website: null });

const COUNTERPARTY = {
  invoiceDirection: "incoming" as const,
  matchedUserAccount: "recipient" as const,
  recipientIdentityMatch: "user" as const,
  issuer: entity("Lieferant GmbH"),
  recipient: entity("Stefan"),
};

function facts(overrides: Partial<ExtractedFacts> = {}): ExtractedFacts {
  return {
    date: "2026-03-01",
    amount: 12000,
    tipAmount: null,
    vatAmount: 2000,
    vatPercent: 20,
    documentVatAmount: 2000,
    qrCodes: null,
    country: "AT",
    lineItems: null,
    rateGroups: null,
    rateGroupsSource: null,
    lineItemsUnreconciled: false,
    unreconciledRates: null,
    partner: "Lieferant GmbH",
    vatId: "ATU12345678",
    iban: null,
    address: null,
    website: null,
    additionalFields: null,
    selfDesignation: "Rechnung",
    invoiceNumber: "R-1",
    referencedInvoiceNumber: null,
    paidInvoiceNumber: null,
    payableAmount: null,
    invoicingAgent: null,
    ...overrides,
  };
}

function invoice(overrides: Partial<ExtractedFacts> = {}, repairAmbiguousFields: string[] = []): ExtractionReading {
  return {
    kind: "invoice",
    facts: facts(overrides),
    counterparty: COUNTERPARTY,
    repairAmbiguousFields,
    run: { extractionComplete: true, extractionError: null, extractedText: "TEXT" },
  };
}

const NOT_INVOICE: ExtractionReading = {
  kind: "not-invoice",
  reason: "Bank statement",
  run: { extractionComplete: true, extractionError: null, extractedText: "(classification only - not an invoice)" },
};

function decide(
  record: Record<string, unknown>,
  reading: ExtractionReading,
  options: { forced?: boolean; linked?: Array<{ id: string; amount: number }> } = {}
): FactOutcome {
  return decideFactChange(
    { record, linkedTransactions: options.linked ?? [] },
    { origin: "extraction", forced: options.forced, reading, at: AT }
  );
}

function accepted(outcome: FactOutcome) {
  if (outcome.refused) throw new Error(`refused: ${outcome.message}`);
  return outcome;
}

const HAND_CORRECTED = {
  userId: "u1",
  extractedAmount: 9900,
  extractedVatPercent: 0,
  extractionCorrectedFields: { amount: day("2026-08-01"), vatPercent: day("2026-08-01") },
  extractionCorrectedAt: day("2026-08-01"),
};

describe("an Extraction on a File with a Hand Correction", () => {
  it("is refused as a whole, naming the corrected fields", () => {
    const outcome = decide(HAND_CORRECTED, invoice());
    expect(outcome).toMatchObject({ refused: true, code: "HAND_CORRECTED", fields: ["amount", "vatPercent"] });
  });

  it("refuses a not-invoice reading too: it would clear the corrected figures", () => {
    expect(decide(HAND_CORRECTED, NOT_INVOICE)).toMatchObject({ refused: true, code: "HAND_CORRECTED" });
  });

  it("forced, overwrites the figures and keeps the record of the correction", () => {
    const { update } = accepted(decide(HAND_CORRECTED, invoice(), { forced: true }));
    expect(update.extractedAmount).toBe(12000);
    expect(update.extractedVatPercent).toBe(20);
    expect("extractionCorrectedFields" in update).toBe(false);
    expect("extractionCorrectedAt" in update).toBe(false);
  });

  it("runs on a File nobody corrected", () => {
    expect(decide({ userId: "u1" }, invoice()).refused).toBe(false);
  });
});

describe("the Due Date and Debit Date of an Extraction", () => {
  const rows = [
    { key: "dueDate" as const, label: "Fällig am", value: "2026-03-15" },
    { key: "debitDate" as const, label: "Einzug am", value: "2026-03-18" },
  ];

  it("are read off the reading's rows, at UTC midnight", () => {
    const { update } = accepted(decide({}, invoice({ additionalFields: rows })));
    expect((update.extractedDueDate as Timestamp).toDate().toISOString()).toBe("2026-03-15T00:00:00.000Z");
    expect(isoOf(update.extractedDebitDate)).toBe("2026-03-18");
  });

  it("are cleared when the reading's rows hold no such row", () => {
    const stored = {
      extractedAdditionalFields: rows,
      extractedDueDate: day("2026-03-15"),
      extractedDebitDate: day("2026-03-18"),
    };
    const { update } = accepted(
      decide(stored, invoice({ additionalFields: [{ key: "invoiceNumber", label: "Nr.", value: "R-1" }] }))
    );
    expect(update.extractedDueDate).toBeNull();
    expect(update.extractedDebitDate).toBeNull();
  });

  it("are cleared, with the rows, when the reading finds no rows at all", () => {
    const stored = {
      extractedAdditionalFields: rows,
      extractedDueDate: day("2026-03-15"),
      extractedDebitDate: day("2026-03-18"),
    };
    const { update } = accepted(decide(stored, invoice({ additionalFields: null })));
    expect(update.extractedAdditionalFields).toBeNull();
    expect(update.extractedDueDate).toBeNull();
    expect(update.extractedDebitDate).toBeNull();
  });

  it("never store a Due Date earlier than the issue date (#135)", () => {
    const { update } = accepted(
      decide({}, invoice({ date: "2026-03-20", additionalFields: [rows[0]] }))
    );
    expect(update.extractedDueDate).toBeNull();
  });

  it("are read against the stored issue date when the reading found none", () => {
    const { update } = accepted(
      decide({ extractedDate: day("2026-03-20") }, invoice({ date: undefined, additionalFields: [rows[0]] }))
    );
    expect("extractedDate" in update).toBe(false);
    expect(update.extractedDueDate).toBeNull();
  });
});

describe("an Extraction's facts", () => {
  it("are stored under the File's field names, the issue date at UTC midnight", () => {
    const { update } = accepted(decide({}, invoice()));
    expect(update).toMatchObject({
      extractedAmount: 12000,
      extractedVatAmount: 2000,
      extractedVatPercent: 20,
      extractedPartner: "Lieferant GmbH",
      extractedVatId: "ATU12345678",
      extractedSelfDesignation: "Rechnung",
      extractedInvoiceNumber: "R-1",
      invoiceDirection: "incoming",
      matchedUserAccount: "recipient",
      recipientIdentityMatch: "user",
      isNotInvoice: false,
      notInvoiceReason: null,
      extractedTipBound: null,
      extractedText: "TEXT",
      extractionComplete: true,
    });
    expect((update.extractedDate as Timestamp).toDate().toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("clear what the reading did not find, except the date, currency and raw text", () => {
    const stored = {
      extractedIban: "AT00 0000",
      extractedCurrency: "EUR",
      extractedRaw: { partner: "old" },
      extractedDate: day("2026-01-01"),
    };
    const { update } = accepted(decide(stored, invoice({ date: undefined })));
    expect(update.extractedIban).toBeNull();
    expect("extractedCurrency" in update).toBe(false);
    expect("extractedRaw" in update).toBe(false);
    expect("extractedDate" in update).toBe(false);
  });

  it("keep the previous VAT when a weaker reading of the same total comes in (fork #137)", () => {
    const stored = {
      extractedAmount: 12000,
      extractedVatPercent: 20,
      extractedVatAmount: 2000,
      extractedRateGroups: [{ rate: 20, net: 10000, vat: 2000, gross: 12000 }],
      extractedRateGroupsSource: "document",
    };
    const { update } = accepted(
      decide(stored, invoice({ vatPercent: null, vatAmount: null, documentVatAmount: null }))
    );
    expect(update.vatSourceDowngraded).toBe(true);
    expect(update.vatFieldsPreserved).toBe(true);
    expect(update.extractedVatPercent).toBe(20);
  });

  it("refuse a run field that is a fact: the module writes those", () => {
    const reading = { ...invoice(), run: { extractedAmount: 1 } } as ExtractionReading;
    expect(() => decide({}, reading)).toThrow(/extractedAmount/);
  });
});

describe("a not-invoice Extraction", () => {
  it("clears every fact, the Due Date and Debit Date included, and the flags that pointed at them", () => {
    const stored = {
      extractedAmount: 12000,
      extractedTipAmount: 300,
      extractedTipBound: { exceeds: false },
      extractedInvoicingAgent: entity("Agent"),
      extractedAdditionalFields: [{ key: "dueDate", label: "Fällig", value: "2026-03-15" }],
      extractedDueDate: day("2026-03-15"),
      extractedDebitDate: day("2026-03-18"),
      needsVatRateReview: true,
      vatRatesOutsideSet: [7],
      needsRepairReview: true,
      repairAmbiguousFields: ["partner"],
    };
    const { update } = accepted(decide(stored, NOT_INVOICE));
    for (const field of [
      "extractedAmount",
      "extractedTipAmount",
      "extractedTipBound",
      "extractedInvoicingAgent",
      "extractedAdditionalFields",
      "extractedDueDate",
      "extractedDebitDate",
      "extractedPartner",
      "extractedLineItems",
      "extractedRateGroups",
    ]) {
      expect(update[field], field).toBeNull();
    }
    expect(update).toMatchObject({
      isNotInvoice: true,
      notInvoiceReason: "Bank statement",
      documentType: "other",
      needsVatRateReview: false,
      needsRepairReview: false,
      needsRksvCodeReview: false,
      needsDirectionReview: false,
      lineItemsUnreconciled: false,
      vatSourceDowngraded: false,
    });
  });

  it("leaves the direction alone when the Extraction never decided a counterparty", () => {
    const { update } = accepted(decide({ invoiceDirection: "outgoing" }, NOT_INVOICE));
    expect("invoiceDirection" in update).toBe(false);
  });
});

describe("the derived fields of an Extraction", () => {
  it("records the repair flag from this reading (#275)", () => {
    const { update } = accepted(decide({}, invoice({}, ["partner"])));
    expect(update).toMatchObject({ needsRepairReview: true, repairAmbiguousFields: ["partner"] });
  });

  it("clears a repair flag an earlier reading left", () => {
    const { update } = accepted(decide({ needsRepairReview: true, repairAmbiguousFields: ["partner"] }, invoice()));
    expect(update.needsRepairReview).toBe(false);
  });

  it("classifies the Document Type on the File as the reading leaves it", () => {
    const { update } = accepted(decide({}, invoice()));
    expect(typeof update.documentType).toBe("string");
    expect(update.documentType).not.toBe("other");
  });

  it("flags a rate outside the Austrian set (#203)", () => {
    const { update } = accepted(decide({}, invoice({ vatPercent: 7, vatAmount: 785 })));
    expect(update.needsVatRateReview).toBe(true);
  });

  it("stamps the write as an Extraction's, which is no Hand Correction", () => {
    const { update } = accepted(decide({}, invoice()));
    expect(update.lastFactChange).toEqual({ origin: "extraction", at: AT });
    expect(update.updatedAt).toBe(AT);
    expect(isHandCorrectionWrite({}, update)).toBe(false);
  });
});

describe("the follow-ups of an Extraction", () => {
  it("syncs the Documentation State of connected Transactions when the Document Type moved", () => {
    const outcome = accepted(decide({ documentType: "invoice", transactionIds: ["t1"] }, NOT_INVOICE));
    expect(outcome.followUps).toEqual([{ kind: "sync-documentation-state", transactionIds: ["t1"] }]);
  });

  it("re-scores nothing: the File's matching runs after an Extraction anyway", () => {
    const outcome = accepted(decide({ extractedAmount: 1, transactionIds: ["t1"] }, invoice()));
    expect(outcome.followUps.map((f) => f.kind)).not.toContain("rescore-suggestions");
  });
});
