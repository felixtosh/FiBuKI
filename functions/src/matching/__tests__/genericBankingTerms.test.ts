/**
 * #235 / #271: German and English banking boilerplate must not reach the
 * Partner name comparison as if it were part of a name.
 *
 * Decision (Felix, 2026-09-27 on #235): strip from the bank-line side only, at
 * the `calculatePartnerScore` callsite. One shared exported term module (the
 * lists move out of patternEngine.ts), word-boundary matching only, never
 * remove a word the Partner name itself contains, and a line that becomes
 * empty after stripping scores 0. Partner names are never modified.
 *
 * #271's AC3 (T-Mobile / "Mobil" substring matching) is out of scope here and
 * filed separately.
 */

import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import {
  GENERIC_BANKING_TERMS_DE,
  GENERIC_BANKING_TERMS_EN,
  stripGenericBankingTerms,
} from "../genericBankingTerms";
import { calculatePartnerScore, TransactionData } from "../transactionScoring";

const tx = (name: string): TransactionData => ({
  id: "t1",
  amount: -1000,
  date: Timestamp.fromDate(new Date("2026-01-05")),
  name,
});

describe("the shared term module (#235)", () => {
  it("exports the German list the AI prompt has always used", () => {
    expect(GENERIC_BANKING_TERMS_DE).toContain("rechnung");
    expect(GENERIC_BANKING_TERMS_DE).toContain("sepa");
    expect(GENERIC_BANKING_TERMS_DE).toContain("lastschrift");
    expect(GENERIC_BANKING_TERMS_DE).toContain("überweisung");
  });

  it("exports the English list the AI prompt has always used", () => {
    expect(GENERIC_BANKING_TERMS_EN).toContain("payment");
    expect(GENERIC_BANKING_TERMS_EN).toContain("direct");
    expect(GENERIC_BANKING_TERMS_EN).toContain("debit");
  });
});

describe("stripGenericBankingTerms", () => {
  it("removes bounded terms, including at hyphen boundaries", () => {
    // `SEPA` in `SEPA-Lastschrift` goes: the hyphen is a word boundary.
    expect(stripGenericBankingTerms("SEPA-Lastschrift Rechnung 4711")).toBe("4711");
  });

  it("never touches a term inside a longer word (word boundaries only)", () => {
    // A Partner named e.g. Rechnungshof is not damaged: "rechnung" is not a
    // bounded word inside "rechnungshof".
    expect(stripGenericBankingTerms("Rechnungshof Wien")).toBe("rechnungshof wien");
  });

  it("keeps a term the Partner name itself contains", () => {
    expect(stripGenericBankingTerms("SEPA Express Zahlung", "Sepa Express GmbH")).toBe(
      "sepa express"
    );
  });

  it("empties a line that is nothing but boilerplate", () => {
    expect(stripGenericBankingTerms("SEPA Lastschrift Rechnung Zahlung")).toBe("");
  });

  it("handles the umlaut spelling", () => {
    expect(stripGenericBankingTerms("Überweisung Maier")).toBe("maier");
  });
});

describe("calculatePartnerScore with banking noise (#235/#271)", () => {
  it("a bank line that is nothing but boilerplate scores 0", () => {
    // Also guards the empty-string trap: "".includes matches everything, so an
    // emptied line must never reach namesMatch.
    const result = calculatePartnerScore(
      { extractedPartner: "Novogenia" },
      tx("SEPA Lastschrift Gutschrift Rechnung")
    );
    expect(result).toEqual({ score: 0, source: null });
  });

  it("no longer scores a name-fragment accident on a stripped noise word", () => {
    // Before #235: "konto" survived into the comparison and sat inside
    // "diskonto", a one-word overlap against a two-word line — 12 points for
    // banking boilerplate. After: both noise words go, the line is empty, 0.
    const result = calculatePartnerScore(
      { extractedPartner: "Diskonto Bank" },
      tx("Konto Überweisung")
    );
    expect(result).toEqual({ score: 0, source: null });
  });

  it("unrelated Partner against a noisy line shares nothing and scores 0", () => {
    const result = calculatePartnerScore(
      { extractedPartner: "Miete Jänner" },
      tx("Rechnung Zahlung Referenz Mandat")
    );
    expect(result).toEqual({ score: 0, source: null });
  });

  it("a true hit is no longer suppressed by noise inflating the bank line", () => {
    // The words2.length <= 2 condition: every noise word made the bank line
    // "long", so one real matching word scored 0. Stripped, the real word is
    // all that is left and the pair scores.
    const result = calculatePartnerScore(
      { extractedPartner: "Wiener Städtische Versicherung Gruppe" },
      tx("Versicherung SEPA Lastschrift Mandat Referenz Verwendung")
    );
    expect(result.score).toBeGreaterThanOrEqual(12);
    expect(result.source).toBe("partner");
  });

  it("a Partner whose own name contains a listed term still matches its lines", () => {
    const result = calculatePartnerScore(
      { extractedPartner: "Sepa Express GmbH" },
      tx("SEPA Express Zahlung 4711")
    );
    expect(result.score).toBeGreaterThanOrEqual(15);
    expect(result.source).toBe("partner");
  });

  it("preserves per candidate: an alias carrying the term keeps it", () => {
    // The preservation check runs against each candidate name, aliases
    // included, not only against extractedPartner.
    const result = calculatePartnerScore(
      { extractedPartner: "Unrelated Name" },
      tx("SEPA Express Zahlung 4711"),
      ["Sepa Express GmbH"]
    );
    expect(result.score).toBeGreaterThanOrEqual(15);
    expect(result.source).toBe("partner");
  });

  it("word boundaries protect a Partner name that embeds a term", () => {
    const result = calculatePartnerScore(
      { extractedPartner: "Rechnungshof" },
      tx("Rechnungshof Überweisung 05/2026")
    );
    expect(result.score).toBeGreaterThanOrEqual(15);
    expect(result.source).toBe("partner");
  });
});
