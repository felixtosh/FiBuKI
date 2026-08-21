/**
 * § 11 UStG document classification (#104).
 *
 * Table-driven against the ways the naive rule fails. The naive reading of
 * the parent issue — "flagged as invoice-ish but carrying neither vatId nor
 * vatPercent is a receipt" — is only half right: below 400 EUR § 11 Abs 6
 * requires no UID at all, and applying the UID test there would demote every
 * legitimate small invoice.
 */

import { describe, it, expect } from "vitest";
import {
  classifyDocumentType,
  KLEINBETRAG_LIMIT_CENTS,
  RECIPIENT_VAT_ID_LIMIT_CENTS,
} from "./classifyDocumentType";
import type { DocumentFacts } from "./types";

/** A document that satisfies § 11 Abs 6 at a small amount. */
function kleinbetrag(overrides: Partial<DocumentFacts> = {}): DocumentFacts {
  return {
    grossTotal: 5400,
    currency: "EUR",
    vatPercent: 20,
    lineItems: [{ description: "USB-C Kabel", vatPercent: 20 }],
    supplierName: "Elektro Huber e.U.",
    supplierAddress: "Musterstraße 1, 1010 Wien",
    issueDate: "2026-03-04",
    selfDesignation: "Rechnung",
    invoiceNumber: null,
    ...overrides,
  };
}

/** A document that satisfies § 11 Abs 1 above the threshold. */
function standard(overrides: Partial<DocumentFacts> = {}): DocumentFacts {
  return {
    grossTotal: 120000,
    currency: "EUR",
    vatPercent: 20,
    lineItems: [{ description: "Beratungsleistung", vatPercent: 20 }],
    supplierName: "Consulting GmbH",
    supplierAddress: "Ringstraße 9, 1010 Wien",
    supplierVatId: "ATU12345678",
    recipientName: "Kunde KG",
    recipientAddress: "Kundenweg 5, 4020 Linz",
    issueDate: "2026-03-04",
    selfDesignation: "Rechnung",
    invoiceNumber: "2026-0042",
    ...overrides,
  };
}

describe("classifyDocumentType — § 11 Abs 6 (Kleinbetragsrechnung, ≤ 400 EUR)", () => {
  it("classifies a small invoice with a rate and NO supplier UID as an invoice", () => {
    const result = classifyDocumentType(kleinbetrag({ supplierVatId: null }));

    expect(result.type).toBe("invoice");
    expect(result.basis.regime).toBe("kleinbetrag");
    expect(result.missingElements).not.toContain("supplier-vat-id");
  });

  it("does NOT classify the same document as an invoice once the rate is gone", () => {
    const result = classifyDocumentType(
      kleinbetrag({
        supplierVatId: null,
        vatPercent: null,
        lineItems: [{ description: "USB-C Kabel" }],
      })
    );

    expect(result.type).not.toBe("invoice");
    expect(result.missingElements).toContain("steuersatz");
  });

  it("reads the rate off the printed rate-group block when there is no top-level rate", () => {
    const result = classifyDocumentType(
      kleinbetrag({ vatPercent: null, lineItems: null, rateGroups: [{ rate: 10 }] })
    );

    expect(result.type).toBe("invoice");
  });

  it("reads the rate off a line item when neither top-level nor rate groups carry one", () => {
    const result = classifyDocumentType(
      kleinbetrag({
        vatPercent: null,
        rateGroups: null,
        lineItems: [{ description: "Kaffee", vatPercent: 10 }],
      })
    );

    expect(result.type).toBe("invoice");
  });

  it("does not demote a small invoice for a missing invoice number", () => {
    const result = classifyDocumentType(kleinbetrag({ invoiceNumber: null }));

    expect(result.type).toBe("invoice");
    expect(result.missingElements).not.toContain("invoice-number");
  });
});

describe("classifyDocumentType — the 400 EUR boundary", () => {
  it("treats exactly 400,00 EUR as a Kleinbetragsrechnung (the statute reads 'nicht übersteigt')", () => {
    const result = classifyDocumentType(
      kleinbetrag({
        grossTotal: KLEINBETRAG_LIMIT_CENTS,
        supplierVatId: null,
        invoiceNumber: null,
      })
    );

    expect(result.basis.regime).toBe("kleinbetrag");
    expect(result.type).toBe("invoice");
  });

  it("treats one cent over 400,00 EUR as the § 11 Abs 1 regime", () => {
    const result = classifyDocumentType(
      kleinbetrag({
        grossTotal: KLEINBETRAG_LIMIT_CENTS + 1,
        supplierVatId: null,
        invoiceNumber: null,
      })
    );

    expect(result.basis.regime).toBe("standard");
    expect(result.type).not.toBe("invoice");
  });

  it("treats one cent under 400,00 EUR as the Kleinbetrag regime", () => {
    const result = classifyDocumentType(
      kleinbetrag({
        grossTotal: KLEINBETRAG_LIMIT_CENTS - 1,
        supplierVatId: null,
        invoiceNumber: null,
      })
    );

    expect(result.basis.regime).toBe("kleinbetrag");
    expect(result.type).toBe("invoice");
  });

  it("ignores the sign of the gross total when picking the regime", () => {
    const result = classifyDocumentType(kleinbetrag({ grossTotal: -5400 }));

    expect(result.basis.regime).toBe("kleinbetrag");
    expect(result.basis.grossTotal).toBe(5400);
  });
});

describe("classifyDocumentType — § 11 Abs 1 (over 400 EUR)", () => {
  it("classifies a document carrying both the UID and the sequential number as an invoice", () => {
    const result = classifyDocumentType(standard());

    expect(result.type).toBe("invoice");
    expect(result.basis.regime).toBe("standard");
    expect(result.missingElements).toEqual([]);
  });

  it("does NOT classify a document missing the supplier UID as an invoice", () => {
    const result = classifyDocumentType(standard({ supplierVatId: null }));

    expect(result.type).not.toBe("invoice");
    expect(result.missingElements).toContain("supplier-vat-id");
  });

  it("does NOT classify a document missing the sequential invoice number as an invoice", () => {
    const result = classifyDocumentType(standard({ invoiceNumber: null }));

    expect(result.type).not.toBe("invoice");
    expect(result.missingElements).toContain("invoice-number");
  });

  it("reports the missing recipient without demoting the document", () => {
    const result = classifyDocumentType(standard({ recipientName: null, recipientAddress: null }));

    expect(result.type).toBe("invoice");
    expect(result.missingElements).toContain("recipient");
  });

  it("reports the missing recipient UID only above 10 000 EUR", () => {
    const under = classifyDocumentType(standard({ recipientVatId: null }));
    const over = classifyDocumentType(
      standard({ grossTotal: RECIPIENT_VAT_ID_LIMIT_CENTS + 100, recipientVatId: null })
    );

    expect(under.missingElements).not.toContain("recipient-vat-id");
    expect(over.missingElements).toContain("recipient-vat-id");
  });
});

describe("classifyDocumentType — reverse charge and exemption must not become receipts", () => {
  it("classifies a reverse-charge invoice with no Austrian rate and no ATU UID as an invoice", () => {
    const result = classifyDocumentType(
      standard({
        vatPercent: 0,
        lineItems: [{ description: "API usage", vatPercent: 0 }],
        supplierVatId: null,
        supplierName: "Anthropic PBC",
        supplierAddress: "San Francisco, CA, USA",
        text: "Reverse charge — VAT to be accounted for by the recipient",
      })
    );

    expect(result.type).toBe("invoice");
    expect(result.basis.zeroVatReason).toBe("reverse-charge");
  });

  it("recognises the German statutory wording as well", () => {
    const result = classifyDocumentType(
      standard({
        vatPercent: null,
        lineItems: null,
        supplierVatId: null,
        text: "Steuerschuldnerschaft des Leistungsempfängers gemäß § 19 Abs 1 UStG",
      })
    );

    expect(result.type).toBe("invoice");
    expect(result.basis.zeroVatReason).toBe("reverse-charge");
  });

  it("classifies a stated exemption as an invoice, not a receipt", () => {
    const result = classifyDocumentType(
      kleinbetrag({
        vatPercent: null,
        lineItems: null,
        text: "Kleinunternehmer gemäß § 6 Abs 1 Z 27 UStG, keine USt",
      })
    );

    expect(result.type).toBe("invoice");
    expect(result.basis.zeroVatReason).toBe("exempt");
  });

  it("treats a non-Austrian supplier UID as reason enough for a missing Austrian rate", () => {
    const result = classifyDocumentType(
      standard({ vatPercent: null, lineItems: null, supplierVatId: "IE6388047V", text: null })
    );

    expect(result.type).toBe("invoice");
    expect(result.basis.zeroVatReason).toBe("foreign-supplier");
  });

  it("does NOT excuse a missing rate on an Austrian supplier with no stated reason", () => {
    const result = classifyDocumentType(
      kleinbetrag({
        vatPercent: null,
        lineItems: null,
        supplierVatId: "ATU12345678",
        text: "Danke für Ihren Einkauf",
      })
    );

    expect(result.type).not.toBe("invoice");
    expect(result.basis.zeroVatReason).toBeNull();
  });
});

describe("classifyDocumentType — receipts", () => {
  it("classifies a Zahlungsbestätigung with an amount and a date and nothing else as a receipt", () => {
    const result = classifyDocumentType({
      grossTotal: 2499,
      currency: "EUR",
      issueDate: "2026-03-04",
      supplierName: "Amazon EU S.à r.l.",
      selfDesignation: "Zahlungsbestätigung",
      invoiceNumber: null,
    });

    expect(result.type).toBe("receipt");
    expect(result.basis.selfDesignationClass).toBe("receipt");
  });

  it("classifies an English payment confirmation the same way", () => {
    const result = classifyDocumentType({
      grossTotal: 2499,
      issueDate: "2026-03-04",
      selfDesignation: "Receipt",
      invoiceNumber: null,
    });

    expect(result.type).toBe("receipt");
  });

  it("classifies a document with no rate, no number and no supplier UID as a receipt even without a heading", () => {
    const result = classifyDocumentType({
      grossTotal: 2499,
      issueDate: "2026-03-04",
      supplierName: "Amazon EU S.à r.l.",
      selfDesignation: null,
      invoiceNumber: null,
    });

    expect(result.type).toBe("receipt");
    expect(result.basis.reason).toBe("no-vat-no-invoice-identity");
  });

  it("classifies a document titled Rechnung that fails § 11 at its amount on the structure, keeping the title in the basis", () => {
    const result = classifyDocumentType(
      standard({ supplierVatId: null, invoiceNumber: null, selfDesignation: "Rechnung" })
    );

    expect(result.type).toBe("receipt");
    expect(result.basis.selfDesignation).toBe("Rechnung");
    expect(result.basis.selfDesignationClass).toBe("invoice");
    expect(result.basis.reason).not.toBe("receipt-designation");
    expect(result.missingElements).toEqual(
      expect.arrayContaining(["supplier-vat-id", "invoice-number"])
    );
  });

  it("does not let a receipt heading demote a document that satisfies § 11", () => {
    const result = classifyDocumentType(standard({ selfDesignation: "Receipt" }));

    expect(result.type).toBe("invoice");
    expect(result.basis.selfDesignationClass).toBe("receipt");
  });
});

describe("classifyDocumentType — honest degradation", () => {
  it("returns unknown rather than picking a regime when the gross total is unknown", () => {
    const result = classifyDocumentType(standard({ grossTotal: null }));

    expect(result.type).toBe("unknown");
    expect(result.basis.regime).toBeNull();
    expect(result.basis.reason).toBe("no-gross-total");
    expect(result.missingElements).toEqual([]);
  });

  it("returns unknown for a legacy record whose only undecidable element is the invoice number", () => {
    const { invoiceNumber: _number, selfDesignation: _title, ...legacy } = standard();
    const result = classifyDocumentType(legacy);

    expect(result.type).toBe("unknown");
    expect(result.basis.degraded).toBe(true);
    expect(result.basis.reason).toBe("legacy-record-undecidable");
  });

  it("still decides a legacy record when a decisive element is missing regardless of the new fields", () => {
    const { invoiceNumber: _number, selfDesignation: _title, ...legacy } = standard({
      supplierVatId: null,
    });
    const result = classifyDocumentType(legacy);

    expect(result.type).toBe("receipt");
    expect(result.basis.degraded).toBe(false);
    expect(result.missingElements).toContain("supplier-vat-id");
  });

  it("decides a legacy Kleinbetrag record on the rate alone, since the invoice number never mattered there", () => {
    const { invoiceNumber: _number, selfDesignation: _title, ...legacy } = kleinbetrag();
    const result = classifyDocumentType(legacy);

    expect(result.type).toBe("invoice");
    expect(result.basis.degraded).toBe(false);
  });
});

describe("classifyDocumentType — non-financial documents", () => {
  it("classifies a document the text classifier already rejected as other", () => {
    const result = classifyDocumentType({ grossTotal: null, isNotInvoice: true });

    expect(result.type).toBe("other");
    expect(result.basis.reason).toBe("not-a-financial-document");
  });

  it("prefers other over the unknown a missing total would otherwise produce", () => {
    const result = classifyDocumentType({
      grossTotal: null,
      isNotInvoice: true,
      selfDesignation: "Mahnung",
    });

    expect(result.type).toBe("other");
  });
});

describe("classifyDocumentType — the basis is inspectable", () => {
  it("records the regime, the total, the heading and the degradation flag", () => {
    const result = classifyDocumentType(kleinbetrag());

    expect(result.basis).toEqual({
      reason: "section-11-satisfied",
      regime: "kleinbetrag",
      grossTotal: 5400,
      selfDesignation: "Rechnung",
      selfDesignationClass: "invoice",
      zeroVatReason: null,
      degraded: false,
    });
  });

  it("never leaves undefined anywhere in the basis, which Firestore refuses to store", () => {
    const { invoiceNumber: _number, selfDesignation: _title, ...legacy } = standard();
    for (const value of Object.values(classifyDocumentType(legacy).basis)) {
      expect(value).not.toBeUndefined();
    }
  });
});

describe("classifyDocumentType — the user's own outgoing documents", () => {
  const failing: DocumentFacts = {
    grossTotal: 84000,
    vatPercent: null,
    lineItems: [{ description: "Beratung" }],
    supplierName: "Yazzbert e.U.",
    supplierAddress: "1040 Wien",
    supplierVatId: "ATU78971436",
    issueDate: "2026-01-09",
    selfDesignation: "Rechnung",
    invoiceNumber: "IV-25-1147",
  };

  it("does not call an outgoing document a receipt — that would chase the user for their own paperwork", () => {
    const received = classifyDocumentType(failing);
    const issued = classifyDocumentType({ ...failing, isOutgoing: true });

    expect(received.type).toBe("receipt");
    expect(issued.type).toBe("unknown");
    expect(issued.basis.reason).toBe("own-outgoing-document");
  });

  it("still reports what the outgoing document is missing", () => {
    const issued = classifyDocumentType({ ...failing, isOutgoing: true });

    expect(issued.missingElements).toContain("steuersatz");
  });

  it("leaves an outgoing document that satisfies § 11 as an invoice", () => {
    const issued = classifyDocumentType({ ...failing, vatPercent: 20, isOutgoing: true });

    expect(issued.type).toBe("invoice");
  });
});

describe("classifyDocumentType — the cross-border B2B shape", () => {
  /** A US vendor: no UID to print, no Austrian rate, but it bills a business. */
  const usVendor: DocumentFacts = {
    grossTotal: 108700,
    currency: "EUR",
    vatPercent: null,
    lineItems: [{ description: "Even G2 Clip & Pouch" }],
    supplierName: "Hong Kong Even Realities Limited",
    supplierAddress: "Kwun Tong, Hong Kong",
    supplierVatId: null,
    recipientName: "Yazzbert e.U.",
    recipientAddress: "1040 Wien, Austria",
    recipientVatId: "ATU78971436",
    issueDate: "2026-07-27",
    selfDesignation: "Invoice",
    invoiceNumber: "24605562011",
    text: "Invoice 24605562011. Total EUR 1,087.00. Amount Paid EUR 1,087.00.",
  };

  it("reads the recipient's Austrian UID on a supplier with none as a supply taxed elsewhere", () => {
    const result = classifyDocumentType(usVendor);

    expect(result.type).toBe("invoice");
    expect(result.basis.zeroVatReason).toBe("cross-border-b2b");
  });

  it("does not need the document to state the reverse-charge wording", () => {
    const result = classifyDocumentType({ ...usVendor, text: null });

    expect(result.type).toBe("invoice");
  });

  it("gives up again once the recipient UID is gone — a bare total is not an invoice", () => {
    const result = classifyDocumentType({ ...usVendor, recipientVatId: null });

    expect(result.type).toBe("unknown");
    expect(result.basis.zeroVatReason).toBeNull();
  });

  it("does not excuse an Austrian supplier who printed a UID but no rate", () => {
    const result = classifyDocumentType({ ...usVendor, supplierVatId: "ATU12345678" });

    expect(result.type).toBe("receipt");
    expect(result.basis.zeroVatReason).toBeNull();
  });

  it("only reads an AUSTRIAN recipient UID — anyone else's is not this user's supply", () => {
    const result = classifyDocumentType({ ...usVendor, recipientVatId: "DE123456789" });

    expect(result.type).toBe("unknown");
  });

  it("keeps a numberless US document out of the chase queue", () => {
    // Without the recipient UID this hits "no VAT, no UID, no number" and
    // reads as a till receipt. The re-extraction sweep is what makes that
    // rule reachable, so the guard has to be in place before it lands.
    //
    // The answer is `unknown`, not `invoice`: § 11 Abs 1 lit. h binds an
    // Austrian invoice, so a missing sequential number on a supply taxed
    // elsewhere is reported but proves nothing either way.
    const numberless = { ...usVendor, invoiceNumber: null };

    expect(classifyDocumentType({ ...numberless, recipientVatId: null }).type).toBe("receipt");

    const crossBorder = classifyDocumentType(numberless);
    expect(crossBorder.type).toBe("unknown");
    expect(crossBorder.missingElements).toContain("invoice-number");
  });

  it("is never consulted when the document prints a rate", () => {
    const result = classifyDocumentType({ ...usVendor, vatPercent: 20, supplierVatId: "ATU12345678" });

    expect(result.type).toBe("invoice");
    expect(result.basis.zeroVatReason).toBeNull();
  });
});

describe("classifyDocumentType — a stated zero rate is a Steuersatz, not a gap", () => {
  /** A Wirtschaftskammer Grundumlage assessment: a levy, never a taxable supply. */
  const levy: DocumentFacts = {
    grossTotal: 8500,
    currency: "EUR",
    vatPercent: 0,
    vatAmount: 0,
    lineItems: [{ description: "FG Werbung und Marktkommunikation 2026" }],
    supplierName: "Wirtschaftskammer Wien",
    supplierAddress: "Straße der Wiener Wirtschaft 1, 1020 Wien",
    supplierVatId: "ATU16211007",
    issueDate: "2026-02-23",
    selfDesignation: "Vorschreibung",
    invoiceNumber: null,
  };

  it("accepts a human recording that the VAT is not claimable", () => {
    const result = classifyDocumentType(levy);

    expect(result.type).toBe("invoice");
    expect(result.basis.zeroVatReason).toBe("zero-rated");
    expect(result.missingElements).not.toContain("steuersatz");
  });

  it("accepts a printed 0% row in the document's own rate-group block", () => {
    const post = classifyDocumentType({
      ...levy,
      grossTotal: 2331,
      vatPercent: null,
      vatAmount: null,
      rateGroups: [{ rate: 0 }],
      supplierName: "Österreichische Post AG",
      supplierVatId: "ATU46674503",
    });

    expect(post.type).toBe("invoice");
    expect(post.basis.zeroVatReason).toBe("zero-rated");
  });

  it("still calls it a receipt when no rate is stated at all", () => {
    const result = classifyDocumentType({ ...levy, vatPercent: null, vatAmount: null });

    expect(result.type).toBe("receipt");
    expect(result.basis.zeroVatReason).toBeNull();
  });

  it("does not read a defaulted zero off the line items", () => {
    const result = classifyDocumentType({
      ...levy,
      vatPercent: null,
      lineItems: [{ description: "Beitrag", vatPercent: 0 }],
    });

    expect(result.type).toBe("receipt");
  });

  it("lets a stated reason outrank a bare zero, because it explains more", () => {
    const result = classifyDocumentType({
      ...levy,
      supplierVatId: null,
      text: "Reverse charge — VAT to be accounted for by the recipient",
    });

    expect(result.basis.zeroVatReason).toBe("reverse-charge");
  });

  it("excuses nothing else: an Austrian supplier over 400 EUR still owes its UID", () => {
    const result = classifyDocumentType({
      ...levy,
      grossTotal: 120000,
      supplierVatId: null,
      recipientName: "Yazzbert e.U.",
      recipientAddress: "1040 Wien",
      invoiceNumber: "2026-0042",
    });

    expect(result.type).not.toBe("invoice");
    expect(result.missingElements).toContain("supplier-vat-id");
  });
});
