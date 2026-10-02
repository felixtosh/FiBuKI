/**
 * #540: one stored shape for every VAT layout, row math that cannot be
 * contradicted, QR payloads parsed by format, and the country of a party.
 *
 * The two receipts are the ones the issue was filed from: Needle Vinyl Bar
 * (three rows, only "davon 20% USt 11,25" under the total) and dm drogerie
 * markt (one row, one printed 20 % group).
 */

import { describe, expect, it } from "vitest";
import { reconcileLineItemsWithDocumentTotal } from "../lineItemReconciliation";
import {
  countryFromVatId,
  enforceGrossRowVat,
  enforceLineItemVat,
  normalizeCountry,
  rateFromDocumentVat,
} from "../taxFacts";
import {
  amountFromPaymentCodes,
  ibanChecksumValid,
  ibanFromPaymentCodes,
  parseQrPayload,
  parseQrPayloads,
  rateGroupsFromRksv,
} from "../qrCodes";
import { buildExtractionCorrection } from "../../files/extractionCorrectionOps";
import { ExtractedLineItem } from "../../types/extraction";

const row = (description: string, amount: number, vatPercent: number | null = null, vatAmount = 0): ExtractedLineItem => ({
  description,
  amount,
  vatPercent,
  vatAmount,
});

describe("rateFromDocumentVat", () => {
  it("finds the one rate that reproduces a printed VAT total", () => {
    expect(rateFromDocumentVat(6750, 1125)).toBe(20);
    expect(rateFromDocumentVat(2200, 367)).toBe(20);
    expect(rateFromDocumentVat(11900, 1900)).toBe(19);
    expect(rateFromDocumentVat(1100, 100)).toBe(10);
    expect(rateFromDocumentVat(10810, 810)).toBe(8.1);
  });

  it("gives no rate when no single rate reproduces the amount (mixed-rate)", () => {
    // 50,00 at 20 % (8,33) + 50,00 at 10 % (4,55) = 12,88 on 100,00
    expect(rateFromDocumentVat(10000, 1288)).toBeNull();
  });

  it("gives no rate for nothing to go on", () => {
    expect(rateFromDocumentVat(null, 100)).toBeNull();
    expect(rateFromDocumentVat(1000, null)).toBeNull();
    expect(rateFromDocumentVat(1000, 0)).toBeNull();
    expect(rateFromDocumentVat(1000, 1000)).toBeNull();
  });
});

describe("Needle Vinyl Bar: VAT printed only under the total", () => {
  const rows = [row("Mexican Sling", 3100), row("Misty Wood", 1550), row("San Cosme Mezcal 4cl", 2100)];

  it("ends as three 20 % rows whose VAT is exactly the printed 11,25", () => {
    const rate = rateFromDocumentVat(6750, 1125);
    const result = reconcileLineItemsWithDocumentTotal(rows, 6750, null, rate);

    expect(result.unreconciled).toBe(false);
    expect(result.lineItems.map((item) => item.vatPercent)).toEqual([20, 20, 20]);
    expect(result.lineItems.reduce((sum, item) => sum + item.vatAmount, 0)).toBe(1125);
    expect(result.lineItems.map((item) => item.amount)).toEqual([3100, 1550, 2100]);
  });

  it("is the same stored shape as the same receipt with its rate on every row", () => {
    const perRow = [
      row("Mexican Sling", 3100, 20, 517),
      row("Misty Wood", 1550, 20, 258),
      row("San Cosme Mezcal 4cl", 2100, 20, 350),
    ];
    const fromTotal = reconcileLineItemsWithDocumentTotal(rows, 6750, null, 20);
    const fromRows = reconcileLineItemsWithDocumentTotal(perRow, 6750, null, 20);
    expect(fromTotal.lineItems).toEqual(fromRows.lineItems);
  });
});

describe("dm drogerie markt: one printed group", () => {
  it("keeps its single row at the group's VAT", () => {
    const result = reconcileLineItemsWithDocumentTotal(
      [row("Foto Sofortdruck", 2200, 20, 367)],
      2200,
      [{ rate: 20, net: 1833, vat: 367, gross: 2200 }],
      20
    );
    expect(result.unreconciled).toBe(false);
    expect(result.lineItems).toEqual([row("Foto Sofortdruck", 2200, 20, 367)]);
  });
});

describe("enforceGrossRowVat", () => {
  it("replaces a VAT the row's own rate and gross contradict", () => {
    // Stefan's Tacos: 10 % of 26,80 taken off the net (2,68); 2,44 is inside it.
    expect(enforceGrossRowVat(row("Tacos", 2680, 10, 268)).vatAmount).toBe(244);
    // Quesadilla: 39,3 % on a 39,30 gross with 3,93 VAT.
    expect(enforceGrossRowVat(row("Quesadilla", 3930, 39.3, 393)).vatAmount).toBe(1109);
  });

  it("keeps a VAT within rounding of the derived one (a split residual)", () => {
    expect(enforceGrossRowVat(row("A", 3100, 20, 518)).vatAmount).toBe(518);
  });

  it("derives the rate from VAT and gross when no rate is given", () => {
    expect(enforceGrossRowVat(row("A", 2680, null, 244)).vatPercent).toBe(10);
    expect(enforceGrossRowVat(row("B", 1000, null, 77)).vatPercent).toBe(8.3);
  });

  it("refuses a VAT no rate can produce", () => {
    expect(() => enforceGrossRowVat(row("A", 1000, null, 1500))).toThrow(RangeError);
    expect(() => enforceGrossRowVat(row("A", 1000, null, -100))).toThrow(RangeError);
  });

  it("leaves a net itemisation the document total reads as net alone", () => {
    const net = [row("Beratung", 10000, 20, 2000), row("Reise", 5000, 20, 1000)];
    expect(enforceLineItemVat(net, 18000)).toEqual(net);
    // Read as gross, the same rows would have been rewritten.
    expect(enforceLineItemVat(net, 15000)[0].vatAmount).toBe(1667);
  });
});

describe("a correction cannot store a contradicting row", () => {
  it("re-derives the VAT of every gross row it posts", () => {
    const { updates } = buildExtractionCorrection(
      {
        lineItems: [
          row("Tacos", 2680, 10, 268),
          row("bowl", 1320, 10, 132),
          row("Quesadilla", 3930, 39.3, 393),
        ],
      },
      { extractedAmount: 7930 }
    );
    const items = updates.extractedLineItems as ExtractedLineItem[];
    expect(items.map((item) => item.vatAmount)).toEqual([244, 120, 1109]);
  });

  it("refuses a row whose VAT exceeds its amount", () => {
    expect(() =>
      buildExtractionCorrection({ lineItems: [row("A", 1000, null, 2000)] }, { extractedAmount: 1000 })
    ).toThrow(/lineItems/);
  });
});

describe("country", () => {
  it("follows the VAT ID prefix", () => {
    expect(countryFromVatId("ATU71726304")).toBe("AT");
    expect(countryFromVatId("DE123456789")).toBe("DE");
    expect(countryFromVatId("EL123456789")).toBe("GR");
    expect(countryFromVatId("CHE-123.456.789 MWST")).toBe("CH");
    expect(countryFromVatId("XI123456789")).toBe("GB");
    expect(countryFromVatId("12345")).toBeNull();
    expect(countryFromVatId(null)).toBeNull();
  });

  it("takes only a two-letter code", () => {
    expect(normalizeCountry(" at ")).toBe("AT");
    expect(normalizeCountry("Austria")).toBeNull();
    expect(normalizeCountry(7)).toBeNull();
  });
});

describe("QR codes", () => {
  const RKSV =
    "_R1-AT1_221430a_RG2026/5840_2026-04-25T00:42:10_67,50_0,00_0,00_0,00_0,00_" +
    "AbCdEf==_1a2b3c_XyZ==_SiGnAtUrE";

  it("parses an RKSV receipt code into per-rate gross", () => {
    const code = parseQrPayload(RKSV);
    expect(code).toMatchObject({
      format: "rksv",
      cashRegisterId: "221430a",
      receiptNumber: "RG2026/5840",
      date: "2026-04-25",
      grossByRate: [{ rate: 20, gross: 6750 }],
    });
  });

  it("uses RKSV groups only when they add up to the document total", () => {
    const codes = parseQrPayloads([RKSV]);
    expect(rateGroupsFromRksv(codes, 6750)).toEqual([{ rate: 20, net: 5625, vat: 1125, gross: 6750 }]);
    expect(rateGroupsFromRksv(codes, 6790)).toBeNull();
  });

  it("splits a mixed-rate RKSV code into one group per bucket", () => {
    const codes = parseQrPayloads([
      "_R1-AT0_K1_42_2026-01-02T10:00:00_12,00_5,50_0,00_0,00_0,00_x_y_z_sig",
    ]);
    expect(rateGroupsFromRksv(codes, 1750)?.map((g) => [g.rate, g.vat])).toEqual([
      [20, 200],
      [10, 50],
    ]);
  });

  it("parses an EPC GiroCode and validates its IBAN", () => {
    const epc = "BCD\n002\n1\nSCT\nBFSWDE33BER\nWikimedia Foerdergesellschaft\nDE33100205000001194700\nEUR123.45\n\nRF18539007547034\n";
    const codes = parseQrPayloads([epc]);
    expect(codes[0]).toMatchObject({
      format: "epc",
      payeeName: "Wikimedia Foerdergesellschaft",
      iban: "DE33100205000001194700",
      amount: 12345,
      currency: "EUR",
      reference: "RF18539007547034",
    });
    expect(ibanFromPaymentCodes(codes)).toBe("DE33100205000001194700");
    expect(amountFromPaymentCodes(codes)).toBe(12345);
  });

  it("never carries an undefined field, which the store would refuse", () => {
    const sparse = parseQrPayload("BCD\n002\n1\nSCT\n\nX\nAT611904300234573201\n");
    expect(sparse).toEqual({
      format: "epc",
      payload: "BCD\n002\n1\nSCT\n\nX\nAT611904300234573201",
      payeeName: "X",
      iban: "AT611904300234573201",
    });
    expect(Object.values(sparse as object)).not.toContain(undefined);
  });

    it("ignores a payment code whose IBAN fails its checksum", () => {
    const epc = "BCD\n002\n1\nSCT\n\nX\nDE33100205000001194701\nEUR1.00";
    expect(ibanFromPaymentCodes(parseQrPayloads([epc]))).toBeNull();
    expect(ibanChecksumValid("AT611904300234573201")).toBe(true);
  });

  it("parses a Swiss QR-bill", () => {
    const lines = Array(31).fill("");
    lines[0] = "SPC";
    lines[1] = "0200";
    lines[2] = "1";
    lines[3] = "CH4431999123000889012";
    lines[5] = "Robert Schneider AG";
    lines[10] = "CH";
    lines[18] = "1949.75";
    lines[19] = "CHF";
    const code = parseQrPayload(lines.join("\n"));
    expect(code).toMatchObject({
      format: "swissQr",
      iban: "CH4431999123000889012",
      payeeName: "Robert Schneider AG",
      country: "CH",
      amount: 194975,
      currency: "CHF",
    });
  });

  it("keeps a verification link as a link and nothing more", () => {
    expect(parseQrPayload("rksv.r2o.at/qr/-egjCbfhHmk")?.format).toBe("url");
    expect(parseQrPayload("hello world")?.format).toBe("unknown");
    expect(parseQrPayload("")).toBeNull();
    expect(parseQrPayloads("not an array")).toEqual([]);
  });
});
