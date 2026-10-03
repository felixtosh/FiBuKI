/**
 * "Service, place of supply abroad (§ 3a Abs 6)" on a FiBuKI Invoice (#565):
 * what it requires before issue, the kind it records, and the note it prints.
 */

import { describe, it, expect } from "vitest";
import {
  invoiceSupplyKind,
  recipientServiceRegion,
  supplyAbroadIssueProblem,
  supplyAbroadNote,
  withoutVat,
} from "../supplyAbroad";
import type { InvoiceLineItem } from "../types";

const LINES: InvoiceLineItem[] = [
  { id: "l1", description: "Consulting", quantity: 1, unitPrice: 189000, vatRate: 0 },
];
const UK = { partnerId: "p1", partnerType: "user" as const, name: "Michael Chaffe", address: { country: "GB" } };
const DE = { partnerId: "p2", partnerType: "user" as const, name: "Kunde GmbH", vatId: "DE123456789", address: { country: "DE" } };
const ISSUER = { entityId: "e1", name: "Stefan EPU", iban: "AT61", vatId: "ATU12345678" };

describe("recipientServiceRegion", () => {
  it("reads the UID prefix first and the address country second", () => {
    expect(recipientServiceRegion(DE)).toBe("eu");
    expect(recipientServiceRegion(UK)).toBe("non-eu");
    expect(recipientServiceRegion({ vatId: "IE6388047V", address: { country: "GB" } })).toBe("eu");
  });
});

describe("withoutVat", () => {
  it("forces every line to 0%", () => {
    const lines = withoutVat([{ ...LINES[0], vatRate: 20 }, { ...LINES[0], id: "l2", vatRate: 10 }]);
    expect(lines.map((l) => l.vatRate)).toEqual([0, 0]);
  });
});

describe("supplyAbroadIssueProblem", () => {
  const invoice = (over: Record<string, unknown> = {}) => ({
    supplyAbroad: true,
    recipient: UK,
    issuer: ISSUER,
    lineItems: LINES,
    ...over,
  });

  it("lets a service to a UK customer through", () => {
    expect(supplyAbroadIssueProblem(invoice())).toBeNull();
  });

  it("checks nothing without the setting", () => {
    expect(supplyAbroadIssueProblem(invoice({ supplyAbroad: false, recipient: { ...UK, address: { country: "AT" } } }))).toBeNull();
  });

  it("refuses an Austrian customer, by country or by UID", () => {
    expect(supplyAbroadIssueProblem(invoice({ recipient: { ...UK, address: { country: "AT" } } }))).toMatch(/Austria/);
    expect(supplyAbroadIssueProblem(invoice({ recipient: { ...UK, vatId: "ATU99999999" } }))).toMatch(/Austria/);
  });

  it("refuses a recipient whose country nothing states", () => {
    expect(supplyAbroadIssueProblem(invoice({ recipient: { ...UK, address: undefined } }))).toMatch(/country or UID/);
  });

  it("refuses an EU customer without a UID, and an issuer without one", () => {
    expect(supplyAbroadIssueProblem(invoice({ recipient: { ...DE, vatId: undefined } }))).toMatch(/customer's UID/);
    expect(supplyAbroadIssueProblem(invoice({ recipient: DE, issuer: { ...ISSUER, vatId: undefined } }))).toMatch(/your own UID/);
    expect(supplyAbroadIssueProblem(invoice({ recipient: DE }))).toBeNull();
  });

  it("refuses a line that still carries VAT", () => {
    expect(supplyAbroadIssueProblem(invoice({ lineItems: [{ ...LINES[0], vatRate: 20 }] }))).toMatch(/0%/);
  });
});

describe("invoiceSupplyKind and the note", () => {
  it("records service-eu or service-non-eu from the recipient, and nothing without the setting", () => {
    expect(invoiceSupplyKind({ supplyAbroad: true, recipient: DE })).toBe("service-eu");
    expect(invoiceSupplyKind({ supplyAbroad: true, recipient: UK })).toBe("service-non-eu");
    expect(invoiceSupplyKind({ supplyAbroad: false, recipient: UK })).toBeNull();
  });

  it("prints the reverse-charge note for the EU and the not-taxable note otherwise, German and English", () => {
    expect(supplyAbroadNote("service-eu")).toEqual({
      de: "Steuerschuldnerschaft des Leistungsempfängers.",
      en: "Reverse charge: VAT to be accounted for by the recipient.",
    });
    expect(supplyAbroadNote("service-non-eu")).toEqual({
      de: "Nicht im Inland steuerbare Leistung.",
      en: "Not taxable in Austria.",
    });
  });
});
