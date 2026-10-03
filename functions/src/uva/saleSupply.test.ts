/**
 * What a 0% sale is (#565): the adapter's precedence and detection, and where
 * the calculation books each kind. A B2B service supplied abroad (§ 3a Abs 6)
 * is not taxable in Austria and reaches no Kennzahl; an export of goods stays
 * in KZ 011; a 0% sale nothing classified stays in KZ 011 and is flagged.
 */

import { describe, it, expect } from "vitest";
import {
  buildUvaTransaction,
  deriveSaleSupply,
  serviceRegionOf,
  type FileRecord,
  type PartnerRecord,
  type TransactionRecord,
} from "./adapter";
import { calculateUva } from "./calculateUva";
import type { UvaPeriod, UvaSaleSupply, UvaTransaction } from "./types";

const ts = (iso: string) => ({ toDate: () => new Date(iso) });
const Q1: UvaPeriod = { year: 2026, period: 1, type: "quarterly" };

const sale = (over: Partial<TransactionRecord> = {}): TransactionRecord => ({
  id: "t-sale",
  date: ts("2026-02-10T00:00:00Z"),
  amount: 189000,
  fileIds: ["f-sale"],
  ...over,
});

/** An uploaded outgoing invoice that prints no VAT. */
const uploadedInvoice = (over: Partial<FileRecord> = {}): FileRecord => ({
  id: "f-sale",
  extractedAmount: 189000,
  extractedVatAmount: 0,
  extractedVatPercent: 0,
  extractedDocumentVatAmount: null,
  matchedUserAccount: "issuer",
  extractedRecipient: { vatId: null, country: "GB" },
  extractedDate: ts("2026-01-30T00:00:00Z"),
  ...over,
});

const fibukiInvoice = (over: Partial<FileRecord> = {}): FileRecord => ({
  ...uploadedInvoice(),
  isFibukiGenerated: true,
  ...over,
});

describe("serviceRegionOf", () => {
  it("reads the UID prefix before the country", () => {
    expect(serviceRegionOf("IE6388047V", "GB")).toBe("eu");
    expect(serviceRegionOf("GB123456789", "IE")).toBe("non-eu");
  });

  it("counts GB and XI as non-EU for services, and Greece's EL prefix as EU", () => {
    expect(serviceRegionOf(null, "GB")).toBe("non-eu");
    expect(serviceRegionOf("XI123456789", null)).toBe("non-eu");
    expect(serviceRegionOf("EL123456789", null)).toBe("eu");
  });

  it("knows nothing without a UID or a country", () => {
    expect(serviceRegionOf(null, null)).toBeNull();
    expect(serviceRegionOf(null, "United Kingdom")).toBeNull();
  });
});

describe("deriveSaleSupply — precedence", () => {
  it("lets the person's override win over the Invoice setting and detection", () => {
    const s = deriveSaleSupply(
      sale({ saleSupplyKind: "export-goods" }),
      [fibukiInvoice({ invoiceSupplyKind: "service-eu" })],
      undefined
    );
    expect(s).toMatchObject({ kind: "export-goods", basis: "manual" });
  });

  it("takes a FiBuKI Invoice's setting over detection", () => {
    const s = deriveSaleSupply(
      sale(),
      [fibukiInvoice({ invoiceSupplyKind: "service-eu" }), uploadedInvoice({ id: "f-2" })],
      undefined
    );
    expect(s).toMatchObject({ kind: "service-eu", basis: "invoice" });
  });

  it("detects a service abroad on an uploaded invoice with no VAT and a foreign customer", () => {
    expect(deriveSaleSupply(sale(), [uploadedInvoice()], undefined)).toMatchObject({
      kind: "service-non-eu",
      basis: "detected",
      serviceDate: "2026-01-30",
    });
  });

  it("leaves a FiBuKI Invoice issued without the setting undetermined", () => {
    expect(deriveSaleSupply(sale(), [fibukiInvoice()], undefined)).toMatchObject({
      kind: "undetermined",
      basis: null,
    });
  });

  it("does not detect when the document prints VAT", () => {
    const printed = uploadedInvoice({ extractedDocumentVatAmount: 37800 });
    expect(deriveSaleSupply(sale(), [printed], undefined)?.kind).toBe("undetermined");
  });

  it("does not detect an Austrian customer", () => {
    const domestic = uploadedInvoice({ extractedRecipient: { vatId: "ATU12345678", country: "AT" } });
    expect(deriveSaleSupply(sale(), [domestic], undefined)?.kind).toBe("undetermined");
  });

  it("reads the customer's country from the UID, then the File, then the Partner", () => {
    const uidOnly = uploadedInvoice({ extractedRecipient: { vatId: "DE123456789", country: "GB" } });
    expect(deriveSaleSupply(sale(), [uidOnly], undefined)?.kind).toBe("service-eu");

    const noCountry = uploadedInvoice({ extractedRecipient: null, extractedCountry: null });
    const partner: PartnerRecord = { id: "p-1", country: "FR" };
    expect(deriveSaleSupply(sale(), [noCountry], partner)?.kind).toBe("service-eu");
    expect(deriveSaleSupply(sale(), [noCountry], undefined)?.kind).toBe("undetermined");
  });

  it("carries the customer's UID", () => {
    const eu = uploadedInvoice({ extractedRecipient: { vatId: "IE6388047V", country: "IE" } });
    expect(deriveSaleSupply(sale(), [eu], undefined)?.customerVatId).toBe("IE6388047V");
  });

  it("resolves nothing for money out", () => {
    expect(deriveSaleSupply(sale({ amount: -1000 }), [uploadedInvoice()], undefined)).toBeNull();
  });

  it("reaches the Partner through buildUvaTransaction", () => {
    const noCountry = uploadedInvoice({ extractedRecipient: null });
    const tx = buildUvaTransaction(sale({ partnerId: "p-1" }), {
      filesById: new Map([["f-sale", noCountry]]),
      categoriesById: new Map(),
      partnersById: new Map([["p-1", { id: "p-1", country: "US" }]]),
    });
    expect(tx.saleSupply).toMatchObject({ kind: "service-non-eu", basis: "detected" });
  });
});

/** A sale at 0% on its document, net 1,890.00. */
const zeroRatedSale = (id: string, supply: UvaSaleSupply | null, date = "2026-02-10"): UvaTransaction => ({
  id,
  date,
  amount: 189000,
  partnerName: "Customer",
  files: [
    {
      id: `f-${id}`,
      totalGross: 189000,
      vatAmount: 0,
      rateGroups: [{ rate: 0, net: 189000, vat: 0, gross: 189000 }],
    },
  ],
  saleSupply: supply,
});

/** A domestic 20% sale, so KZ 000 is never empty. */
const DOMESTIC: UvaTransaction = {
  id: "t-domestic",
  date: "2026-02-12",
  amount: 12000,
  files: [{ id: "f-domestic", totalGross: 12000, rateGroups: [{ rate: 20, net: 10000, vat: 2000, gross: 12000 }] }],
};

const kz = (r: ReturnType<typeof calculateUva>, code: string) => r.kennzahlen[code]?.value ?? 0;

describe("calculateUva — where a 0% sale lands (#565)", () => {
  it("keeps a service abroad off every Kennzahl and lists it as not taxable in Austria", () => {
    for (const kind of ["service-eu", "service-non-eu"] as const) {
      const r = calculateUva({
        period: Q1,
        transactions: [DOMESTIC, zeroRatedSale("t-svc", { kind, basis: "manual" })],
      });
      expect(kz(r, "000")).toBe(10000);
      expect(r.kennzahlen["011"]).toBeUndefined();
      expect(r.kennzahlen["021"]).toBeUndefined();
      expect(r.outputVatByRate.find((g) => g.rate === 0)).toBeUndefined();
      expect(r.zeroRatedSales).toEqual([
        expect.objectContaining({ transactionId: "t-svc", net: 189000, kind, needsReview: false }),
      ]);
    }
  });

  it("books no KZ 000 count for a sale that is wholly a service abroad", () => {
    const r = calculateUva({
      period: Q1,
      transactions: [zeroRatedSale("t-svc", { kind: "service-non-eu", basis: "manual" })],
    });
    expect(r.kennzahlen["000"]).toBeUndefined();
  });

  it("keeps an export of goods in KZ 011 and KZ 000", () => {
    const r = calculateUva({
      period: Q1,
      transactions: [zeroRatedSale("t-goods", { kind: "export-goods", basis: "manual" })],
    });
    expect(kz(r, "011")).toBe(189000);
    expect(kz(r, "000")).toBe(189000);
    expect(r.zeroRatedSales?.[0]).toMatchObject({ kind: "export-goods", needsReview: false });
  });

  it("books an undetermined 0% sale as before and flags it", () => {
    const r = calculateUva({ period: Q1, transactions: [zeroRatedSale("t-unknown", null)] });
    expect(kz(r, "011")).toBe(189000);
    expect(kz(r, "000")).toBe(189000);
    expect(r.zeroRatedSales?.[0]).toMatchObject({ kind: "undetermined", basis: null, needsReview: true });
  });

  it("flags a detected kind until a person confirms it", () => {
    const r = calculateUva({
      period: Q1,
      transactions: [zeroRatedSale("t-detected", { kind: "service-non-eu", basis: "detected" })],
    });
    expect(r.kennzahlen["011"]).toBeUndefined();
    expect(r.zeroRatedSales?.[0].needsReview).toBe(true);
  });

  it("ignores the kind on a sale with no 0% part", () => {
    const r = calculateUva({
      period: Q1,
      transactions: [{ ...DOMESTIC, saleSupply: { kind: "service-eu", basis: "manual" } }],
    });
    expect(kz(r, "022")).toBe(10000);
    expect(r.zeroRatedSales).toEqual([]);
  });

  it("does not move KZ 095 when a 0% sale is reclassified", () => {
    const before = calculateUva({ period: Q1, transactions: [DOMESTIC, zeroRatedSale("t", null)] });
    const after = calculateUva({
      period: Q1,
      transactions: [DOMESTIC, zeroRatedSale("t", { kind: "service-non-eu", basis: "manual" })],
    });
    expect(kz(after, "000")).toBe(kz(before, "000") - 189000);
    expect(after.balance).toBe(before.balance);
    expect(kz(after, "095")).toBe(kz(before, "095"));
  });
});

describe("calculateUva — the EU services the ZM counts (#565)", () => {
  const eu = (id: string, paid: string, served: string) =>
    zeroRatedSale(id, { kind: "service-eu", basis: "invoice", customerVatId: "DE123456789", serviceDate: served }, paid);

  it("counts a service performed in the quarter and paid in the next", () => {
    const transactions = [eu("t-late", "2026-04-15", "2026-03-20")];
    const q1 = calculateUva({ period: Q1, transactions });
    const q2 = calculateUva({ period: { ...Q1, period: 2 }, transactions });

    expect(q1.zmServices).toEqual([
      expect.objectContaining({ transactionId: "t-late", serviceDate: "2026-03-20", paidOn: "2026-04-15", net: 189000 }),
    ]);
    expect(q2.zmServices).toEqual([]);
    // The UVA itself stays on the cash basis: the sale is Q2's, off the form.
    expect(q2.zeroRatedSales?.[0].transactionId).toBe("t-late");
    expect(q1.zeroRatedSales).toEqual([]);
  });

  it("counts no non-EU service and no undetermined sale", () => {
    const r = calculateUva({
      period: Q1,
      transactions: [
        zeroRatedSale("t-uk", { kind: "service-non-eu", basis: "manual", serviceDate: "2026-02-01" }),
        zeroRatedSale("t-unknown", null),
      ],
    });
    expect(r.zmServices).toEqual([]);
  });
});
