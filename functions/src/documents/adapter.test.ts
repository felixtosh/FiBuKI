/**
 * Files-record → DocumentFacts adaptation (#104).
 *
 * The interesting cases are the ones where a record can lie about itself: a
 * legacy record that never had the new fields must not read as a document
 * that printed none.
 */

import { describe, it, expect } from "vitest";
import { classifyFileRecord, documentTypeFields, toDocumentFacts } from "./adapter";

describe("toDocumentFacts", () => {
  it("prefers the issuer entity over the flat legacy fields", () => {
    const facts = toDocumentFacts({
      extractedIssuer: { name: "Consulting GmbH", vatId: "ATU12345678", address: "Wien" },
      extractedPartner: "Someone Else",
      extractedVatId: "DE999999999",
      extractedAddress: "Berlin",
    });

    expect(facts.supplierName).toBe("Consulting GmbH");
    expect(facts.supplierVatId).toBe("ATU12345678");
    expect(facts.supplierAddress).toBe("Wien");
  });

  it("falls back to the flat legacy fields on a pre-entity record", () => {
    const facts = toDocumentFacts({
      extractedPartner: "Elektro Huber e.U.",
      extractedVatId: "ATU12345678",
      extractedAddress: "Wien",
    });

    expect(facts.supplierName).toBe("Elektro Huber e.U.");
    expect(facts.supplierVatId).toBe("ATU12345678");
  });

  it("distinguishes a field the record never had from one extraction found empty", () => {
    expect(toDocumentFacts({}).invoiceNumber).toBeUndefined();
    expect(toDocumentFacts({ extractedInvoiceNumber: null }).invoiceNumber).toBeNull();
    expect(toDocumentFacts({}).selfDesignation).toBeUndefined();
    expect(toDocumentFacts({ extractedSelfDesignation: null }).selfDesignation).toBeNull();
  });

  it("reads a Timestamp document date as present without pretending to parse it", () => {
    const facts = toDocumentFacts({ extractedDate: { toDate: () => new Date() } });
    expect(facts.issueDate).toBe("present");
    expect(toDocumentFacts({ extractedDate: null }).issueDate).toBeNull();
  });

  it("ignores array fields that are not arrays", () => {
    const facts = toDocumentFacts({ extractedLineItems: "nope", extractedRateGroups: 3 });
    expect(facts.lineItems).toBeNull();
    expect(facts.rateGroups).toBeNull();
  });
});

describe("classifyFileRecord", () => {
  it("classifies a stored Kleinbetragsrechnung as an invoice", () => {
    const result = classifyFileRecord({
      extractedAmount: 5400,
      extractedVatPercent: 20,
      extractedDate: { toDate: () => new Date() },
      extractedLineItems: [{ description: "USB-C Kabel", vatPercent: 20 }],
      extractedIssuer: { name: "Elektro Huber e.U.", address: "Wien", vatId: null },
      extractedSelfDesignation: "Rechnung",
      extractedInvoiceNumber: null,
    });

    expect(result.type).toBe("invoice");
  });

  it("classifies a stored payment confirmation as a receipt", () => {
    const result = classifyFileRecord({
      extractedAmount: 2499,
      extractedDate: { toDate: () => new Date() },
      extractedIssuer: { name: "Amazon EU S.à r.l.", address: "Luxembourg", vatId: null },
      extractedSelfDesignation: "Zahlungsbestätigung",
      extractedInvoiceNumber: null,
    });

    expect(result.type).toBe("receipt");
  });

  it("classifies a file the text classifier rejected as other", () => {
    expect(classifyFileRecord({ isNotInvoice: true, extractedAmount: null }).type).toBe("other");
  });
});

describe("documentTypeFields", () => {
  it("carries no undefined, which Firestore refuses to store", () => {
    const fields = documentTypeFields(classifyFileRecord({ extractedAmount: null }));

    expect(Object.keys(fields).sort()).toEqual([
      "documentType",
      "documentTypeBasis",
      "documentTypeMissingElements",
    ]);
    for (const value of Object.values(fields)) expect(value).not.toBeUndefined();
    for (const value of Object.values(fields.documentTypeBasis as Record<string, unknown>)) {
      expect(value).not.toBeUndefined();
    }
  });
});

// ============================================================================
// Corpus shapes (#104)
//
// Real records from the live corpus, reduced to the fields classification
// reads. These are the cases a rule table gets wrong in the expensive
// direction — a good invoice demoted to a receipt puts phantom work in the
// chase queue.
// ============================================================================

describe("classifyFileRecord — corpus shapes", () => {
  it("does not demote a Hong Kong supplier's invoice with no VAT and no UID to a receipt", () => {
    // 2026-07-27 Invoice-24605562011.pdf — EUR 1087.00, third-country
    // supplier, no Austrian rate anywhere, no supplier UID, and this record
    // predates the transcribed heading.
    const result = classifyFileRecord({
      extractedAmount: 108700,
      extractedCurrency: "EUR",
      extractedVatPercent: null,
      extractedVatAmount: null,
      extractedDate: { toDate: () => new Date("2026-07-27") },
      extractedLineItems: [{ description: "Even G2 Clip & Pouch", vatPercent: null }],
      extractedIssuer: {
        name: "Hong Kong Even Realities Limited",
        vatId: null,
        address: "Room 29D, 8/F, On Cheong Factory Building, Kwun Tong, Hong Kong",
      },
      extractedRecipient: { name: "Stefan Yazzie Herbert", vatId: null, address: "1040 Wien, Austria" },
      extractedText: "Invoice 24605562011 Supplier: Hong Kong Even Realities Limited …",
      extractedAdditionalFields: [{ label: "Invoice Number", value: "24605562011" }],
    });

    expect(result.type).not.toBe("receipt");
    expect(result.type).toBe("unknown");
    expect(result.basis.degraded).toBe(true);
  });

  it("classifies a UK supplier's Kleinbetragsrechnung with a printed 20% rate as an invoice", () => {
    // Paddle.com Market Ltd, EUR 29.99, GB UID, 20% VAT printed.
    const result = classifyFileRecord({
      extractedAmount: 2999,
      extractedCurrency: "EUR",
      extractedVatPercent: 20,
      extractedVatAmount: 500,
      extractedDate: { toDate: () => new Date("2026-07-28") },
      extractedLineItems: [{ description: "iMazing Personal Subscription", vatPercent: 20 }],
      extractedIssuer: {
        name: "Paddle.com Market Ltd",
        vatId: "GB150848114",
        address: "30 Old Bailey, London, EC4M 7AU, United Kingdom",
      },
      extractedRecipient: { name: "Yazzbert e.U.", vatId: "ATU78971436", address: "1040 Wien" },
    });

    expect(result.type).toBe("invoice");
    expect(result.basis.regime).toBe("kleinbetrag");
  });

  it("classifies a legacy Amazon Rechnung over 400 EUR today, from the invoice number extraction already stored", () => {
    // paperless-ap-1181.pdf — EUR 503.20, ATU UID, printed rate group, and an
    // invoice number that only exists under extractedAdditionalFields because
    // the record predates the dedicated field.
    const result = classifyFileRecord({
      extractedAmount: 50320,
      extractedCurrency: "EUR",
      extractedVatPercent: 20,
      extractedVatAmount: 8387,
      extractedRateGroups: [{ rate: 20, net: 41933, vat: 8387, gross: 50320 }],
      extractedDate: { toDate: () => new Date("2026-03-26") },
      extractedLineItems: [{ description: "Samsung 990 PRO NVMe M.2 SSD", vatPercent: 20 }],
      extractedIssuer: {
        name: "Amazon Business EU S.à r.l.",
        vatId: "ATU73569248",
        address: "38 avenue John F. Kennedy, L-1855 Luxembourg",
      },
      extractedRecipient: {
        name: "STEFAN YAZZIE HERBERT",
        vatId: "ATU78971436",
        address: "MARGARETENSTRASSE 22/2, WIEN, 1040, AT",
      },
      extractedAdditionalFields: [
        { label: "Invoice Number", value: "AT69G9CABEI" },
        { label: "Order Date", value: "2026-03-25" },
      ],
    });

    expect(result.type).toBe("invoice");
    expect(result.missingElements).toEqual([]);
  });

  it("does not read a date label as an invoice number", () => {
    const facts = toDocumentFacts({
      extractedAdditionalFields: [
        { label: "Invoice Date", value: "2026-03-25" },
        { label: "Rechnungsdatum", value: "26.03.2026" },
      ],
    });

    expect(facts.invoiceNumber).toBeUndefined();
  });

  it("reads a combined label the way extraction actually writes it", () => {
    const facts = toDocumentFacts({
      extractedAdditionalFields: [{ label: "Order Number / Invoice", value: "#81317066-168345506" }],
    });

    expect(facts.invoiceNumber).toBe("#81317066-168345506");
  });

  it("never lets the additional-fields fallback assert an ABSENT invoice number", () => {
    // No label matches, so the answer stays "this record cannot say" — which
    // is what keeps a legacy foreign invoice out of the chase queue.
    expect(toDocumentFacts({ extractedAdditionalFields: [{ label: "Payment Method", value: "Card" }] })
      .invoiceNumber).toBeUndefined();
    // An explicit stored null, however, IS an absence.
    expect(toDocumentFacts({ extractedInvoiceNumber: null, extractedAdditionalFields: [] })
      .invoiceNumber).toBeNull();
  });
});

describe("toDocumentFacts — outgoing detection", () => {
  it("reads the two ways the record says the user is the issuer", () => {
    expect(toDocumentFacts({ matchedUserAccount: "issuer" }).isOutgoing).toBe(true);
    expect(toDocumentFacts({ invoiceDirection: "outgoing" }).isOutgoing).toBe(true);
  });

  it("treats a received document, or one it cannot place, as not outgoing", () => {
    expect(toDocumentFacts({ matchedUserAccount: "recipient" }).isOutgoing).toBe(false);
    expect(toDocumentFacts({ invoiceDirection: "unknown" }).isOutgoing).toBe(false);
    expect(toDocumentFacts({}).isOutgoing).toBe(false);
  });
});
