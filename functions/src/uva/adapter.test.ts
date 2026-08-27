import { describe, it, expect } from "vitest";
import {
  buildUvaTransaction,
  deriveForeignRegime,
  toUvaFile,
  toViennaCalendarDay,
  TEMPLATE_VAT_TREATMENT,
  type FileRecord,
  type TransactionRecord,
} from "./adapter";

const ts = (iso: string) => ({ toDate: () => new Date(iso) });

const baseOpts = () => ({
  filesById: new Map<string, FileRecord>(),
  categoriesById: new Map(),
});

describe("toViennaCalendarDay", () => {
  it("reads the UTC date part of the stored UTC-midnight timestamp", () => {
    expect(toViennaCalendarDay(ts("2026-03-31T00:00:00Z"))).toBe("2026-03-31");
    // even when the host runs in a negative-offset timezone the stored
    // instant's UTC date is what counts
    expect(toViennaCalendarDay(ts("2026-01-01T00:00:00.000Z"))).toBe("2026-01-01");
  });
});

describe("toUvaFile", () => {
  it("prefers the issuer UID over the flat extracted UID", () => {
    const f = toUvaFile({
      id: "f1",
      extractedAmount: 1000,
      extractedVatId: "ATU00000000",
      extractedIssuer: { vatId: "DE123456789" },
    });
    expect(f.supplierVatId).toBe("DE123456789");
    expect(f.totalGross).toBe(1000);
  });

  it("carries the printed Trinkgeld, absent on a file that has none (#172)", () => {
    expect(toUvaFile({ id: "f-tip", extractedAmount: 5080, extractedTipAmount: 320 }).tipAmount).toBe(320);
    expect(toUvaFile({ id: "f-no-tip", extractedAmount: 5080 }).tipAmount).toBeNull();
  });

  it("carries extractedCurrency (fork #87)", () => {
    expect(toUvaFile({ id: "f-usd", extractedAmount: 3600, extractedCurrency: "USD" }).currency).toBe("USD");
    expect(toUvaFile({ id: "f-eur", extractedAmount: 3600 }).currency).toBeNull();
  });
});

describe("deriveForeignRegime", () => {
  const anthropicFile = toUvaFile({
    id: "f-anthropic",
    extractedAmount: 2160,
    extractedVatAmount: null,
    extractedVatPercent: null,
    extractedIssuer: { vatId: "IE3232093PH" },
  });

  it("classifies a foreign-UID zero-VAT expense as heuristic reverse charge", () => {
    const tx: TransactionRecord = {
      id: "t",
      date: ts("2026-01-15T00:00:00Z"),
      amount: -2160,
    };
    const regime = deriveForeignRegime(tx, [anthropicFile]);
    expect(regime).toEqual({ kind: "service", origin: "eu", basis: "heuristic" });
  });

  it("honors the isReverseCharge override without a file", () => {
    const tx: TransactionRecord = {
      id: "t",
      date: ts("2026-01-15T00:00:00Z"),
      amount: -2160,
      isReverseCharge: true,
    };
    expect(deriveForeignRegime(tx, [])).toEqual({
      kind: "service",
      origin: "third-country",
      basis: "override",
    });
  });

  it("does not classify when the foreign document charges VAT (D2 lane instead)", () => {
    const deFile = toUvaFile({
      id: "f-de",
      extractedAmount: 11900,
      extractedVatAmount: 1900,
      extractedVatPercent: 19,
      extractedIssuer: { vatId: "DE123456789" },
    });
    const tx: TransactionRecord = {
      id: "t",
      date: ts("2026-01-15T00:00:00Z"),
      amount: -11900,
    };
    expect(deriveForeignRegime(tx, [deFile])).toBeNull();
  });

  it("isReverseCharge === false vetoes the heuristic (goods-classified-elsewhere lane)", () => {
    const tx: TransactionRecord = {
      id: "t",
      date: ts("2026-01-15T00:00:00Z"),
      amount: -2160,
      isReverseCharge: false,
    };
    expect(deriveForeignRegime(tx, [anthropicFile])).toBeNull();
  });

  it("never classifies income", () => {
    const tx: TransactionRecord = {
      id: "t",
      date: ts("2026-01-15T00:00:00Z"),
      amount: 2160,
    };
    expect(deriveForeignRegime(tx, [anthropicFile])).toBeNull();
  });
});

describe("buildUvaTransaction", () => {
  it("resolves vatTreatment from the category record, falling back to the template default", () => {
    const opts = baseOpts();
    opts.categoriesById.set("c1", { id: "c1", templateId: "bank-fees" });
    const tx = buildUvaTransaction(
      {
        id: "t",
        date: ts("2026-02-01T00:00:00Z"),
        amount: -500,
        noReceiptCategoryId: "c1",
      },
      opts
    );
    expect(tx.noReceiptCategory?.vatTreatment).toBe("exempt-class");

    opts.categoriesById.set("c2", {
      id: "c2",
      templateId: "bank-fees",
      vatTreatment: "needs-receipt",
    });
    const tx2 = buildUvaTransaction(
      { ...txRecord(), noReceiptCategoryId: "c2" },
      opts
    );
    expect(tx2.noReceiptCategory?.vatTreatment).toBe("needs-receipt");
  });

  it("falls back to the transaction's own templateId when the category doc is missing", () => {
    const tx = buildUvaTransaction(
      {
        ...txRecord(),
        noReceiptCategoryId: "gone",
        noReceiptCategoryTemplateId: "receipt-lost",
      },
      baseOpts()
    );
    expect(tx.noReceiptCategory?.vatTreatment).toBe("needs-receipt");
  });

  it("maps connected files and drops dangling fileIds", () => {
    const opts = baseOpts();
    opts.filesById.set("f1", { id: "f1", extractedAmount: 1200, extractedVatPercent: 20 });
    const tx = buildUvaTransaction(
      { ...txRecord(), fileIds: ["f1", "missing"] },
      opts
    );
    expect(tx.files).toHaveLength(1);
    expect(tx.files?.[0].totalGross).toBe(1200);
  });

  it("carries the transaction currency (fork #87)", () => {
    const opts = baseOpts();
    expect(buildUvaTransaction({ ...txRecord(), currency: "EUR" }, opts).currency).toBe("EUR");
    expect(buildUvaTransaction(txRecord(), opts).currency).toBeNull();
  });

  it("passes prior instalment fractions through", () => {
    const opts = {
      ...baseOpts(),
      priorClaimedFractionByFileId: new Map([["f1", 0.63]]),
    };
    opts.filesById.set("f1", { id: "f1", extractedAmount: 8400, extractedVatPercent: 20 });
    const tx = buildUvaTransaction({ ...txRecord(), fileIds: ["f1"] }, opts);
    expect(tx.priorClaimedFraction).toBeCloseTo(0.63);
  });

  it("every hardcoded template has a treatment mapping", () => {
    for (const id of [
      "bank-fees",
      "interest",
      "internal-transfers",
      "payment-provider-settlements",
      "taxes-government",
      "payroll",
      "private-personal",
      "zero-value",
      "receipt-lost",
    ]) {
      expect(TEMPLATE_VAT_TREATMENT[id], id).toBeDefined();
    }
  });
});

function txRecord(): TransactionRecord {
  return { id: "t", date: ts("2026-02-01T00:00:00Z"), amount: -1000 };
}

describe("toUvaFile — an invoice addressed to somebody else (#229)", () => {
  const thirdPartyInvoice = (): FileRecord => ({
    id: "f-third-party",
    extractedAmount: 48000,
    extractedVatAmount: 8000,
    extractedVatPercent: 20,
    foreignRecipient: true,
  });

  it("keeps its VAT out of Vorsteuer — the supply was not rendered to this user", () => {
    expect(toUvaFile(thirdPartyInvoice()).nonClaimableVatReason).toBe("foreign-recipient");
  });

  it("leaves a document addressed to the user claimable", () => {
    expect(
      toUvaFile({ ...thirdPartyInvoice(), foreignRecipient: false }).nonClaimableVatReason
    ).toBeNull();
    expect(
      toUvaFile({ ...thirdPartyInvoice(), foreignRecipient: undefined }).nonClaimableVatReason
    ).toBeNull();
  });

  it("does not overwrite a reason a human already recorded", () => {
    const marked = toUvaFile({ ...thirdPartyInvoice(), vatNotClaimableReason: "private" });

    expect(marked.nonClaimableVatReason).toBe("private");
  });
});
