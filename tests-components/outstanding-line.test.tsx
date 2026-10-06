/**
 * #615: what the File panel's Outstanding line shows. The figure is
 * `deriveOutstanding`'s; the line names its state: still open, paid, or paid
 * with something on top (Stefan, 2026-10-05: an overpayment stays visible).
 */

import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import de from "@/messages/de.json";
import { outstandingLineState, type OutstandingLineFile } from "@/lib/matching/outstanding-line";

const invoice: OutstandingLineFile = {
  id: "f",
  extractedAmount: 120000,
  extractedCurrency: "EUR",
  extractionComplete: true,
  transactionIds: ["t-1"],
};
const paying = (id: string, amount: number, currency = "EUR") => ({ id, amount: -amount, currency });

describe("outstandingLineState", () => {
  it("shows what is still open after a part payment", () => {
    expect(outstandingLineState(invoice, [paying("t-1", 40000)], [invoice])).toEqual({
      kind: "open",
      outstanding: 80000,
      total: 120000,
    });
  });

  it("reads paid within the close tolerance", () => {
    expect(outstandingLineState(invoice, [paying("t-1", 120050)], [invoice])).toEqual({ kind: "paid" });
  });

  it("keeps an overpayment visible beyond the tolerance", () => {
    expect(outstandingLineState(invoice, [paying("t-1", 125000)], [invoice])).toEqual({
      kind: "overpaid",
      overpaid: 5000,
    });
  });

  it("adds up two payments that come to more than the File", () => {
    const twice = { ...invoice, transactionIds: ["t-1", "t-2"] };
    expect(outstandingLineState(twice, [paying("t-1", 100000), paying("t-2", 100000)], [twice])).toEqual({
      kind: "overpaid",
      overpaid: 80000,
    });
  });

  it("does not call a shared bank line's excess this File's overpayment", () => {
    const small = { ...invoice, extractedAmount: 30000 };
    const other: OutstandingLineFile = { ...invoice, id: "g", extractedAmount: 20000 };
    expect(outstandingLineState(small, [paying("t-1", 60000)], [small, other])).toEqual({ kind: "paid" });
  });

  it("shows nothing for a payment in another currency, or with no payment", () => {
    expect(outstandingLineState(invoice, [paying("t-1", 40000, "USD")], [invoice])).toEqual({ kind: "hidden" });
    expect(outstandingLineState(invoice, [], [invoice])).toEqual({ kind: "hidden" });
  });
});

describe("the line's words", () => {
  it("say the overpayment in both languages", () => {
    expect(en.files.outstanding.overpaid).toBe("Paid in full, +{amount}");
    expect(de.files.outstanding.overpaid).toBe("Vollständig bezahlt, +{amount}");
    expect(en.files.outstanding.figure).toContain("{outstanding}");
    expect(de.files.outstanding.figure).toContain("{total}");
  });
});
