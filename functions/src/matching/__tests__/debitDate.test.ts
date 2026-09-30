/**
 * #136: the Debit Date (Einzugsdatum), the date a Partner states it will
 * collect under a SEPA mandate, as its own concept beside the Due Date.
 *
 * A Due Date is a deadline the User may or may not hit; a Debit Date is what
 * the Partner will do, so it is stronger Match evidence, and near-proof when
 * the bank line is a direct debit.
 */

import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import {
  scoreTransaction,
  toFileMatchingData,
  toTransactionData,
  SCORING_CONFIG,
  FileMatchingData,
  TransactionData,
} from "../transactionScoring";
import { debitDateFromAdditionalFields, isDebitDateHit } from "../debitDate";
import { dueDateFromAdditionalFields } from "../dueDate";
import { normalizeTransactionType, transactionTypeFromRawRow } from "../../imports/transactionType";
import { toDateSafe } from "../../utils/toDateSafe";

function ts(dateStr: string): Timestamp {
  return Timestamp.fromDate(new Date(dateStr));
}

const ISSUE = "2026-01-05";
const DEBIT = "2026-01-20";

describe("debitDateFromAdditionalFields", () => {
  it("reads the vocabulary key whatever the printed wording", () => {
    const date = debitDateFromAdditionalFields([
      { key: "debitDate", label: "wird eingezogen am", value: DEBIT },
    ]);
    expect(date?.getDate()).toBe(20);
  });

  it("reads a keyless legacy row printed as Einzugsdatum", () => {
    expect(debitDateFromAdditionalFields([{ label: "Einzugsdatum:", value: DEBIT }])?.getDate()).toBe(20);
  });

  it("is not a Due Date, and a Due Date is not it", () => {
    expect(debitDateFromAdditionalFields([{ key: "dueDate", label: "Fällig am", value: DEBIT }])).toBeNull();
    expect(dueDateFromAdditionalFields([{ key: "debitDate", label: "Einzugsdatum", value: DEBIT }])).toBeNull();
  });

  it("rejects a Debit Date earlier than the issue date", () => {
    expect(
      debitDateFromAdditionalFields([{ key: "debitDate", value: "2026-01-02" }], new Date(2026, 0, 5))
    ).toBeNull();
  });

  it("rejects a value that is not an ISO date", () => {
    expect(debitDateFromAdditionalFields([{ key: "debitDate", value: "frühestens am 20." }])).toBeNull();
  });
});

describe("isDebitDateHit", () => {
  const debit = new Date(2026, 0, 16); // a Friday

  it("hits on the Debit Date itself", () => {
    expect(isDebitDateHit(debit, new Date(2026, 0, 16))).toBe(true);
  });

  it("hits when the collection settles after a weekend", () => {
    expect(isDebitDateHit(debit, new Date(2026, 0, 19))).toBe(true);
  });

  it("does not hit before the Debit Date: the Partner collects on it, never earlier", () => {
    expect(isDebitDateHit(debit, new Date(2026, 0, 15))).toBe(false);
  });

  it("does not hit past the settlement lag", () => {
    expect(isDebitDateHit(debit, new Date(2026, 0, 16 + SCORING_CONFIG.DEBIT_DATE_SETTLEMENT_DAYS + 1))).toBe(false);
  });
});

describe("normalizeTransactionType", () => {
  it.each([
    ["SEPA-Lastschrift", "direct_debit"],
    ["Lastschrift", "direct_debit"],
    ["Einzugsermächtigung", "direct_debit"],
    ["Direct Debit", "direct_debit"],
    ["SEPA Core Direct Debit", "direct_debit"],
    ["Dauerauftrag", "standing_order"],
    ["Standing Order", "standing_order"],
    ["Überweisung", "transfer"],
    ["Ueberweisung", "transfer"],
    ["SEPA Credit Transfer", "transfer"],
    ["Transfer", "transfer"],
    ["Kartenzahlung", "card"],
    ["Bankomat", "card"],
    ["Card Payment", "card"],
    ["Debit Card", "card"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizeTransactionType(raw)).toBe(expected);
  });

  it.each([
    ["DIRECT_DEBIT", "direct_debit"],
    ["CARD_PAYMENT", "card"],
    ["STANDING-ORDER", "standing_order"],
    ["Debit Transfer", "transfer"],
    ["Credit Transfer", "transfer"],
  ])("reads bank-API spellings: %s -> %s", (raw, expected) => {
    expect(normalizeTransactionType(raw)).toBe(expected);
  });

  it("leaves wordings that do not say how money moved unknown", () => {
    // TrueLayer's PURCHASE and BILL_PAYMENT can be a card, a transfer or a debit.
    expect(normalizeTransactionType("PURCHASE")).toBeNull();
    expect(normalizeTransactionType("BILL_PAYMENT")).toBeNull();
    expect(normalizeTransactionType("DEBIT")).toBeNull();
    expect(normalizeTransactionType("CASHBACK")).toBeNull();
  });

  it("returns null for anything it cannot name, rather than guessing", () => {
    expect(normalizeTransactionType("Sonstiges")).toBeNull();
    expect(normalizeTransactionType("")).toBeNull();
    expect(normalizeTransactionType(null)).toBeNull();
    expect(normalizeTransactionType(undefined)).toBeNull();
  });
});

describe("transactionTypeFromRawRow", () => {
  it("prefers the column the Source mapped", () => {
    expect(transactionTypeFromRawRow({ Art: "Lastschrift", Type: "Card Payment" }, "Art")).toBe("direct_debit");
  });

  it("falls back to the headers banks and bank APIs use", () => {
    expect(transactionTypeFromRawRow({ transaction_category: "DIRECT_DEBIT", transaction_type: "DEBIT" })).toBe("direct_debit");
    expect(transactionTypeFromRawRow({ Type: "CARD_PAYMENT" })).toBe("card");
    expect(transactionTypeFromRawRow({ type: "Überweisung" })).toBe("transfer");
    expect(transactionTypeFromRawRow({ Buchungsart: "Dauerauftrag" })).toBe("standing_order");
  });

  it("is null for a row with no type column or none it can read", () => {
    expect(transactionTypeFromRawRow({ Betrag: "-10,00" })).toBeNull();
    expect(transactionTypeFromRawRow(undefined)).toBeNull();
    expect(transactionTypeFromRawRow({ transaction_category: "PURCHASE" })).toBeNull();
  });
});

describe("scoreTransaction with a Debit Date", () => {
  const file: FileMatchingData = {
    extractedAmount: 3999,
    extractedCurrency: "EUR",
    extractedDate: ts(ISSUE),
    extractedDueDate: null,
    extractedDebitDate: ts(DEBIT),
    extractedPartner: null,
    extractedIban: null,
    extractedText: null,
    partnerId: null,
  };
  const tx: TransactionData = {
    id: "tx-1",
    amount: -3999,
    date: ts("2026-01-21"),
    currency: "EUR",
    name: "Magenta Telekom",
  };

  it("a cent-exact collection one day after the Debit Date earns the same-day bonus", () => {
    const result = scoreTransaction(file, tx);
    expect(result.matchSources).toContain("debit_date");
    expect(result.breakdown.date).toBe(25);
    expect(result.breakdown.hardFacts).toBe(SCORING_CONFIG.HARD_FACTS_BONUS_SAME_DAY);
    expect(result.confidence).toBe(85);
  });

  it("weighs above a Due Date: the same day off a Due Date does not earn the same-day bonus", () => {
    const asDue = scoreTransaction({ ...file, extractedDebitDate: null, extractedDueDate: ts(DEBIT) }, tx);
    expect(asDue.breakdown.hardFacts).toBeLessThan(SCORING_CONFIG.HARD_FACTS_BONUS_SAME_DAY);
    expect(scoreTransaction(file, tx).confidence).toBeGreaterThan(asDue.confidence);
  });

  it("is near-proof when the bank line is a direct debit", () => {
    const result = scoreTransaction(file, { ...tx, transactionType: "direct_debit" });
    expect(result.breakdown.hardFacts).toBe(
      SCORING_CONFIG.HARD_FACTS_BONUS_SAME_DAY + SCORING_CONFIG.DEBIT_DATE_DIRECT_DEBIT_BONUS
    );
    expect(result.confidence).toBe(95);
  });

  it("gives no direct-debit bonus without a cent-exact amount", () => {
    const result = scoreTransaction(file, { ...tx, amount: -4500, transactionType: "direct_debit" });
    expect(result.breakdown.hardFacts).toBe(0);
  });

  it("changes nothing for a Transaction outside the collection window", () => {
    const far = { ...tx, date: ts("2026-01-10") };
    expect(scoreTransaction(file, far)).toEqual(scoreTransaction({ ...file, extractedDebitDate: null }, far));
  });

  it("reads the typed field, and on a legacy record the additional-fields bag", () => {
    expect(toFileMatchingData({ extractedDebitDate: ts(DEBIT) }).extractedDebitDate).toEqual(ts(DEBIT));
    const legacy = toFileMatchingData({
      extractedAdditionalFields: [{ key: "debitDate", label: "Einzugsdatum", value: DEBIT }],
    });
    expect(toDateSafe(legacy.extractedDebitDate)?.getDate()).toBe(20);
  });

  it("carries the Transaction's type into the scorer", () => {
    expect(
      toTransactionData("t1", { amount: -1, date: ts(DEBIT), transactionType: "direct_debit" })
        .transactionType
    ).toBe("direct_debit");
  });
});

describe("the extraction vocabulary", () => {
  it("keeps debitDate, so the prompt's field survives the closed-key filter", async () => {
    const { ADDITIONAL_FIELD_KEYS } = await import("../../extraction/geminiParser");
    expect(ADDITIONAL_FIELD_KEYS).toContain("debitDate");
  });
});
