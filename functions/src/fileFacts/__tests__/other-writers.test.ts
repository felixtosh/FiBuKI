/**
 * The File facts module at its interface, for the other writers (#640):
 * marking a File Not Invoice, the identity sweep, a generated invoice and the
 * entity-name backfill.
 *
 * Each case gives the module a File and a Fact Change and reads the outcome:
 * the complete File update, the follow-ups, and for the sweep the direction a
 * Hand Correction kept. No database. The writers' own doors are covered on the
 * self-host shim (`selfhost/other-fact-writers.test.ts`, the sweep suite).
 *
 *   npx vitest run src/fileFacts/__tests__/other-writers.test.ts --pool=forks --maxWorkers=1
 */

import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import {
  decideFactChange,
  generatedInvoiceFileFacts,
  reExtractionRefusal,
  type FactChange,
  type FactUpdate,
} from "../factChange";
import { buildInvoiceFileFields, draftFileStubFields } from "../../invoicing/buildInvoiceFileFields";
import type { Invoice } from "../../invoicing/types";

const AT = Timestamp.fromDate(new Date("2026-10-05T10:00:00Z"));
const EARLIER = Timestamp.fromDate(new Date("2026-09-01T10:00:00Z"));
const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));

function decide(
  record: Record<string, unknown>,
  change: FactChange,
  linkedTransactions: Array<{ id: string; amount: number }> = []
): FactUpdate {
  const outcome = decideFactChange({ record, linkedTransactions }, change);
  if (outcome.refused) throw new Error(`refused: ${outcome.message}`);
  return outcome;
}

// ---------------------------------------------------------------------------
// Not Invoice
// ---------------------------------------------------------------------------

/** What marking wrote before #640, field for field (the old builder, with an auto-matched Partner). */
const MARKED_BEFORE_640: Record<string, unknown> = {
  isNotInvoice: true,
  notInvoiceReason: "bank statement",
  classificationComplete: true,
  extractedDate: null,
  extractedAmount: null,
  extractedCurrency: null,
  extractedVatPercent: null,
  extractedVatAmount: null,
  extractedLineItems: null,
  extractedRateGroups: null,
  extractedRateGroupsSource: null,
  lineItemsUnreconciled: false,
  lineItemsUnreconciledRates: null,
  vatSourceDowngraded: false,
  vatFieldsPreserved: false,
  needsVatRateReview: false,
  vatRatesOutsideSet: [],
  needsRepairReview: false,
  repairAmbiguousFields: [],
  needsRksvCodeReview: false,
  rksvCodeDisagreeingRates: [],
  extractedPartner: null,
  extractedVatId: null,
  extractedIban: null,
  extractedAddress: null,
  extractedText: null,
  extractedRaw: null,
  extractedAdditionalFields: null,
  extractedFields: null,
  extractionConfidence: null,
  invoiceDirection: null,
  extractionComplete: true,
  partnerMatchComplete: false,
  partnerSuggestions: [],
  transactionMatchComplete: false,
  transactionSuggestions: [],
  partnerId: null,
  partnerType: null,
  partnerMatchedBy: null,
  partnerMatchConfidence: null,
};

/** An invoice File as an Extraction leaves it, with a Due Date row and a tip. */
function invoiceFile(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: "u1",
    isNotInvoice: false,
    extractionComplete: true,
    extractedAmount: 12000,
    extractedVatAmount: 2000,
    extractedVatPercent: 20,
    extractedDate: day("2026-03-01"),
    extractedTipAmount: 300,
    extractedTipBound: "within-total",
    extractedDueDate: day("2026-03-15"),
    extractedDebitDate: null,
    extractedAdditionalFields: [{ key: "dueDate", label: "Fällig", value: "2026-03-15" }],
    extractedPartner: "Lieferant GmbH",
    invoiceDirection: "incoming",
    documentType: "invoice",
    needsDirectionReview: false,
    partnerId: "p1",
    partnerMatchedBy: "auto",
    transactionIds: [],
    ...extra,
  };
}

describe("marking a File Not Invoice", () => {
  it("writes every field it wrote before, with the same values", () => {
    const { update } = decide(invoiceFile(), { origin: "not-invoice", reason: "bank statement", at: AT });

    for (const [field, value] of Object.entries(MARKED_BEFORE_640)) {
      expect(update[field], field).toEqual(value);
    }
  });

  it("also clears the tip, its bound, the Due Date and the Debit Date, and stamps the write", () => {
    const { update } = decide(invoiceFile(), { origin: "not-invoice", at: AT });

    expect(update.extractedTipAmount).toBeNull();
    expect(update.extractedTipBound).toBeNull();
    expect(update.extractedDueDate).toBeNull();
    expect(update.extractedDebitDate).toBeNull();
    expect(update.lastFactChange).toEqual({ origin: "not-invoice", at: AT });
    expect(update.updatedAt).toBe(AT);

    // Nothing else beyond the old set: no Document Type, no direction review,
    // and no Hand Correction keys on a File that has no record.
    const added = Object.keys(update).filter((field) => !(field in MARKED_BEFORE_640));
    expect(added.sort()).toEqual(
      [
        "extractedDebitDate",
        "extractedDueDate",
        "extractedTipAmount",
        "extractedTipBound",
        "lastFactChange",
        "updatedAt",
      ].sort()
    );
  });

  it("clears the Hand Correction record for the figures it wipes, so a later re-extraction is not refused", () => {
    const record = invoiceFile({
      extractionCorrectedFields: { amount: EARLIER, invoiceDirection: EARLIER, tipAmount: EARLIER, dueDate: AT },
      extractionCorrectedAt: AT,
    });
    expect(reExtractionRefusal(record, {})).not.toBeNull();

    const { update } = decide(record, { origin: "not-invoice", at: AT });

    expect(update.extractionCorrectedFields).toBeNull();
    expect(update.extractionCorrectedAt).toBeNull();
    // Un-marking re-extracts the File; on the File as marking left it, that
    // re-extraction is no longer refused.
    expect(reExtractionRefusal({ ...record, ...update }, {})).toBeNull();
  });

  it("keeps a stamp it does not know, and dates the record by it", () => {
    const record = invoiceFile({
      extractionCorrectedFields: { amount: AT, someRenamedField: EARLIER },
      extractionCorrectedAt: AT,
    });

    const { update } = decide(record, { origin: "not-invoice", at: AT });

    expect(update.extractionCorrectedFields).toEqual({ someRenamedField: EARLIER });
    expect(update.extractionCorrectedAt).toBe(EARLIER);
  });

  it("keeps a Partner the User chose by hand", () => {
    const { update } = decide(invoiceFile({ partnerMatchedBy: "manual" }), { origin: "not-invoice", at: AT });

    expect("partnerId" in update).toBe(false);
    expect("partnerMatchedBy" in update).toBe(false);
  });

  it("asks for no follow-up: the Document Type is not moved", () => {
    const { followUps } = decide(invoiceFile({ transactionIds: ["t1"] }), { origin: "not-invoice", at: AT });

    expect(followUps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The identity sweep
// ---------------------------------------------------------------------------

const entity = (name: string | null, extra: Record<string, unknown> = {}) => ({
  name,
  vatId: null,
  address: null,
  iban: null,
  website: null,
  ...extra,
});

/** A purchase the sweep reads as one: the User is the recipient. */
const DERIVED_INCOMING = {
  invoiceDirection: "incoming" as const,
  matchedUserAccount: "recipient" as const,
  recipientIdentityMatch: "user" as const,
  counterparty: entity("ACME Handels GmbH", { vatId: "ATU12345678" }),
};

function sweptFile(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: "u1",
    extractionComplete: true,
    extractedIssuer: entity("ACME Handels GmbH"),
    extractedRecipient: entity("Stefan Bandit"),
    extractedPartner: "Stefan Bandit",
    extractedAmount: 12000,
    invoiceDirection: "outgoing",
    matchedUserAccount: "issuer",
    recipientIdentityMatch: "user",
    partnerId: "p-manual",
    partnerMatchedBy: "manual",
    transactionIds: [],
    ...extra,
  };
}

describe("the identity sweep", () => {
  it("keeps a direction the User set by hand, with the counterparty it chose, and says so", () => {
    const record = sweptFile({
      extractionCorrectedFields: { invoiceDirection: EARLIER },
      extractionCorrectedAt: EARLIER,
    });

    const outcome = decide(record, { origin: "identity-sweep", derived: DERIVED_INCOMING, at: AT });

    expect(outcome.update).toEqual({});
    expect(outcome.keptDirection).toEqual({ stored: "outgoing", derived: "incoming" });
  });

  it("still moves the recipient verdict beside a kept direction, and re-derives the Document Type", () => {
    const record = sweptFile({
      recipientIdentityMatch: "unknown",
      extractionCorrectedFields: { invoiceDirection: EARLIER },
      extractionCorrectedAt: EARLIER,
    });

    const outcome = decide(record, { origin: "identity-sweep", derived: DERIVED_INCOMING, at: AT });

    expect(outcome.update.recipientIdentityMatch).toBe("user");
    expect("invoiceDirection" in outcome.update).toBe(false);
    expect("matchedUserAccount" in outcome.update).toBe(false);
    expect("extractedPartner" in outcome.update).toBe(false);
    expect("partnerId" in outcome.update).toBe(false);
    expect(outcome.update.documentType).toBeDefined();
    expect(outcome.update.lastFactChange).toEqual({ origin: "identity-sweep", at: AT });
    expect(outcome.keptDirection).toEqual({ stored: "outgoing", derived: "incoming" });
  });

  it("writes a hand-corrected File normally when the derivation agrees with the User", () => {
    const record = sweptFile({
      invoiceDirection: "incoming",
      matchedUserAccount: "recipient",
      extractionCorrectedFields: { invoiceDirection: EARLIER },
      extractionCorrectedAt: EARLIER,
    });

    const outcome = decide(record, { origin: "identity-sweep", derived: DERIVED_INCOMING, at: AT });

    expect(outcome.keptDirection).toBeNull();
    expect(outcome.update.extractedPartner).toBe("ACME Handels GmbH");
  });

  it("re-points direction and counterparty on a File nobody corrected, and re-arms partner matching", () => {
    const outcome = decide(sweptFile({ partnerMatchedBy: "auto" }), {
      origin: "identity-sweep",
      derived: DERIVED_INCOMING,
      at: AT,
    });

    expect(outcome.keptDirection).toBeNull();
    expect(outcome.update).toMatchObject({
      invoiceDirection: "incoming",
      matchedUserAccount: "recipient",
      recipientIdentityMatch: "user",
      extractedPartner: "ACME Handels GmbH",
      extractedVatId: "ATU12345678",
      extractedIban: null,
      extractedAddress: null,
      extractedWebsite: null,
      partnerMatchComplete: false,
      partnerId: null,
      partnerSuggestions: [],
      lastFactChange: { origin: "identity-sweep", at: AT },
      updatedAt: AT,
    });
  });

  it("recomputes the direction review against the connected Transactions", () => {
    // The sweep makes the File a purchase while its Transaction is money in.
    const outcome = decide(
      sweptFile({ transactionIds: ["t1"], needsDirectionReview: false }),
      { origin: "identity-sweep", derived: DERIVED_INCOMING, at: AT },
      [{ id: "t1", amount: 12000 }]
    );

    expect(outcome.update.needsDirectionReview).toBe(true);
    expect(outcome.update.directionConflictTransactionIds).toEqual(["t1"]);
  });

  it("asks for the Documentation State sync when the Document Type moves on a connected File", () => {
    // Never classified before, so any Document Type the sweep derives is a move.
    const outcome = decide(sweptFile({ transactionIds: ["t1"] }), {
      origin: "identity-sweep",
      derived: DERIVED_INCOMING,
      at: AT,
    });

    expect(outcome.followUps).toEqual([{ kind: "sync-documentation-state", transactionIds: ["t1"] }]);
  });

  it("writes nothing on a File that already holds what it derived", () => {
    const record = sweptFile({
      invoiceDirection: "incoming",
      matchedUserAccount: "recipient",
      extractedPartner: "ACME Handels GmbH",
    });

    const outcome = decide(record, { origin: "identity-sweep", derived: DERIVED_INCOMING, at: AT });

    expect(outcome.update).toEqual({});
    expect(outcome.followUps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A generated invoice
// ---------------------------------------------------------------------------

const INVOICE = {
  id: "inv1",
  userId: "u1",
  number: "2026-001",
  status: "issued",
  issuer: {
    entityId: "e1",
    name: "Stefan Bandit e.U.",
    vatId: "ATU99999999",
    address: { street: "Gasse 1", postalCode: "1010", city: "Wien", country: "AT" },
    iban: "AT611904300234573201",
  },
  recipient: {
    partnerId: "p1",
    partnerType: "user",
    name: "Kunde GmbH",
    address: { postalCode: "8010", city: "Graz", country: "AT" },
  },
  issueDate: day("2026-10-01"),
  paymentTerms: "14 Tage",
  dueDate: day("2026-10-15"),
  lineItems: [
    { id: "l1", description: "Beratung", quantity: 2, unitPrice: 5000, vatRate: 20 },
    { id: "l2", description: "Buch", quantity: 1, unitPrice: 1000, vatRate: 10 },
  ],
  currency: "EUR",
  subtotal: 11000,
  vatAmount: 2100,
  total: 13100,
  createdAt: day("2026-10-01"),
  updatedAt: day("2026-10-01"),
} as unknown as Invoice;

describe("a generated invoice", () => {
  it("writes the invoice's facts as before, and no derived field", () => {
    const facts = generatedInvoiceFileFacts(INVOICE, AT);

    expect(facts).toEqual({
      invoiceDirection: "outgoing",
      matchedUserAccount: "issuer",
      extractedDate: INVOICE.issueDate,
      extractedAmount: 13100,
      extractedCurrency: "EUR",
      extractedVatAmount: 2100,
      extractedVatPercent: null,
      extractedPartner: "Kunde GmbH",
      extractedIban: "AT611904300234573201",
      extractedLineItems: [
        { description: "Beratung", vatPercent: 20, vatAmount: 2000, amount: 12000 },
        { description: "Buch", vatPercent: 10, vatAmount: 100, amount: 1100 },
      ],
      extractedIssuer: {
        name: "Stefan Bandit e.U.",
        vatId: "ATU99999999",
        address: "Gasse 1, 1010 Wien, AT",
        iban: "AT611904300234573201",
        website: null,
      },
      extractedRecipient: {
        name: "Kunde GmbH",
        vatId: null,
        address: "8010 Graz, AT",
        iban: null,
        website: null,
      },
      extractedVatId: null,
      extractedAddress: "8010 Graz, AT",
      lastFactChange: { origin: "generated-invoice", at: AT },
      updatedAt: AT,
    });
  });

  it("keeps the File's field set: the fields it had before, plus the stamp", () => {
    const fields = buildInvoiceFileFields(INVOICE, { storagePath: "s", downloadUrl: "d", fileSize: 1 });

    expect(Object.keys(fields).sort()).toEqual(
      [
        "fileName", "fileType", "fileSize", "storagePath", "downloadUrl", "classificationComplete",
        "isNotInvoice", "isFibukiGenerated", "invoiceId", "invoiceDirection", "matchedUserAccount",
        "extractedDate", "extractedAmount", "extractedCurrency", "extractedVatAmount",
        "extractedVatPercent", "extractedPartner", "extractedIban", "extractedLineItems",
        "extractedIssuer", "extractedRecipient", "extractedVatId", "extractedAddress",
        "invoiceSupplyKind", "updatedAt", "lastFactChange",
      ].sort()
    );
  });

  it("gives a draft's stub only its direction", () => {
    const stub = draftFileStubFields("inv1");

    expect(stub.invoiceDirection).toBe("outgoing");
    expect(stub.matchedUserAccount).toBe("issuer");
    expect(Object.keys(stub).filter((key) => key.startsWith("extracted"))).toEqual([]);
    expect((stub.lastFactChange as { origin: string }).origin).toBe("generated-invoice");
  });
});

// ---------------------------------------------------------------------------
// The entity-name backfill
// ---------------------------------------------------------------------------

describe("the entity-name backfill", () => {
  it("decodes the stored names and keeps every other entity field", () => {
    const outcome = decide(
      {
        extractedIssuer: entity("AL&amp;FA Taxi KG", { vatId: "ATU1" }),
        extractedRecipient: entity("Stefan"),
        extractedPartner: "AL&amp;FA Taxi KG",
      },
      { origin: "entity-name-backfill", at: AT }
    );

    expect(outcome.update).toEqual({
      extractedIssuer: entity("AL&FA Taxi KG", { vatId: "ATU1" }),
      extractedPartner: "AL&FA Taxi KG",
      lastFactChange: { origin: "entity-name-backfill", at: AT },
      updatedAt: AT,
    });
  });

  it("writes nothing when every name decodes to itself, a bare ampersand included", () => {
    const outcome = decide(
      { extractedIssuer: entity("Q & A Solutions"), extractedPartner: "AT&T" },
      { origin: "entity-name-backfill", at: AT }
    );

    expect(outcome.update).toEqual({});
  });
});
