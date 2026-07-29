/**
 * CHARACTERIZATION TESTS for the matching engine's pure domain logic.
 *
 * These tests pin the CURRENT behavior of the matching/scoring/learning code
 * exactly as it runs in production today — including quirks and asymmetries —
 * so that the planned rewrite can be verified as behavior-preserving.
 *
 * DO NOT "fix" a failing assertion here by changing the expected value to the
 * intuitively correct one: if one of these fails, the ported code diverged.
 * Quirks are marked with `// characterization: ...` comments.
 *
 * Covers (not covered by the existing unit tests):
 * - Cologne phonetics exact codes and edge quirks
 * - Company-name normalization (suffix stripping order effects, umlauts)
 * - Company-name similarity exact scores (phonetic 92, containment 75+coverage)
 * - Partner matching confidences, ranking/tie-breaking, pattern exclusions
 * - Glob/pattern matching anchoring, escaping, umlaut handling
 * - Transaction scoring: amount tolerance asymmetry, currency rounding,
 *   reference/date-bonus interplay, IBAN, precision hint tiers, weight order
 * - Category matching exact confidences, boosts, rule precedence
 * - Pattern learning pipeline outputs (with a scripted fake Gemini model)
 */

import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import type { GenerativeModel } from "@google-cloud/vertexai";
import {
  colognePhonetic,
  normalizeUrl,
  normalizeCompanyName,
  calculateCompanyNameSimilarity,
  matchTransaction,
  shouldAutoApply,
  PartnerData,
  TransactionData as PartnerTxData,
} from "../../utils/partner-matcher";
import { globMatch, matchPatternFlexible, normalizeUmlauts } from "../../utils/pattern-utils";
import {
  scoreTransaction,
  calculateAmountScore,
  calculateDateScore,
  calculateReferenceScore,
  normalizeName,
  namesMatch,
  FileMatchingData,
  TransactionData as ScoringTxData,
} from "../transactionScoring";
import {
  matchTransactionToCategories,
  shouldAutoApplyCategory,
  isEligibleForCategoryMatching,
  CategoryData,
  TransactionData as CategoryTxData,
  CategoryMatchRule,
} from "../../utils/category-matcher";
import {
  learnPatterns,
  formatTxFields,
  TxSample,
  PatternLearningInput,
} from "../patternEngine";

function ts(dateStr: string): Timestamp {
  return Timestamp.fromDate(new Date(dateStr));
}

// ============================================================================
// 1. Cologne Phonetics (colognePhonetic)
// ============================================================================

describe("colognePhonetic — exact codes", () => {
  it("Müller / Mueller / MULLER share code 657", () => {
    expect(colognePhonetic("Müller")).toBe("657");
    expect(colognePhonetic("Mueller")).toBe("657");
    expect(colognePhonetic("MULLER")).toBe("657");
  });

  it("Meyer / Maier share code 67", () => {
    expect(colognePhonetic("Meyer")).toBe("67");
    expect(colognePhonetic("Maier")).toBe("67");
  });

  it("Schmidt / Schmitt share code 862", () => {
    expect(colognePhonetic("Schmidt")).toBe("862");
    expect(colognePhonetic("Schmitt")).toBe("862");
  });

  it("Straße / Strasse share code 8278 (ß→ss)", () => {
    expect(colognePhonetic("Straße")).toBe("8278");
    expect(colognePhonetic("Strasse")).toBe("8278");
  });

  it("Bahnhof → 163 (h is silent)", () => {
    expect(colognePhonetic("Bahnhof")).toBe("163");
  });

  it("Xaver → 4837 (leading x expands to 48)", () => {
    expect(colognePhonetic("Xaver")).toBe("4837");
  });

  it("Pham → 36 (ph coded 3)", () => {
    expect(colognePhonetic("Pham")).toBe("36");
  });

  // characterization: standard Kölner Phonetik keeps the code of a leading
  // vowel; this implementation strips ALL zeros, including the first one.
  it("adidas → 228 (leading vowel code dropped)", () => {
    expect(colognePhonetic("adidas")).toBe("228");
  });

  // characterization: 'h' produces an empty code but lastCode is NOT reset,
  // so identical codes across an 'h' collapse ("aha" → single 0 → "0").
  it("aha → '0' (vowels around h collapse into one code)", () => {
    expect(colognePhonetic("aha")).toBe("0");
  });

  it("returns '' for empty/non-letter input and '0' for all-vowel input", () => {
    expect(colognePhonetic("")).toBe("");
    expect(colognePhonetic("12 34!")).toBe("");
    expect(colognePhonetic("aeiou")).toBe("0");
  });
});

// ============================================================================
// 2. Company name normalization (normalizeCompanyName)
// ============================================================================

describe("normalizeCompanyName", () => {
  it("strips a single legal suffix and expands umlauts (after punctuation strip)", () => {
    expect(normalizeCompanyName("Hetzner Online GmbH")).toBe("hetzner online");
    expect(normalizeCompanyName("Müller AG")).toBe("mueller");
    expect(normalizeCompanyName("Österreichische Post AG")).toBe("oesterreichische post");
  });

  // characterization: suffixes are applied sequentially, so after "KG" and
  // "& Co." are stripped, the "mbh" suffix rule eats the tail of "GmbH",
  // leaving a dangling "g".
  it("'Müller GmbH & Co. KG' → 'mueller g' (mbh rule eats GmbH tail)", () => {
    expect(normalizeCompanyName("Müller GmbH & Co. KG")).toBe("mueller g");
  });

  // characterization: the e.u. suffix rule runs BEFORE s.a.r.l. in list
  // order, so once s.a.r.l. is stripped the remaining "eu" is never removed.
  it("'Amazon EU S.a.r.l.' → 'amazon eu' (eu survives)", () => {
    expect(normalizeCompanyName("Amazon EU S.a.r.l.")).toBe("amazon eu");
  });

  it("suffixes are anchored to the end — 'ag' inside a word survives", () => {
    expect(normalizeCompanyName("Wagner")).toBe("wagner");
    expect(normalizeCompanyName("Magenta Telekom")).toBe("magenta telekom");
  });

  it("returns '' for empty and suffix-only input", () => {
    expect(normalizeCompanyName("")).toBe("");
    expect(normalizeCompanyName("LLC")).toBe("");
    expect(normalizeCompanyName("GmbH")).toBe("");
  });
});

describe("normalizeUrl", () => {
  it("strips protocol, www, trailing slash, query and fragment", () => {
    expect(normalizeUrl("https://www.Hetzner.com/cloud?x=1#top")).toBe("hetzner.com/cloud");
    expect(normalizeUrl("http://netflix.com/")).toBe("netflix.com");
    expect(normalizeUrl("")).toBe("");
  });
});

// ============================================================================
// 3. Company name similarity (calculateCompanyNameSimilarity)
// ============================================================================

describe("calculateCompanyNameSimilarity — exact values", () => {
  it("100 for identical after normalization (umlaut variants included)", () => {
    expect(calculateCompanyNameSimilarity("Amazon", "amazon")).toBe(100);
    // ü→ue expansion makes these identical BEFORE the phonetic branch
    expect(calculateCompanyNameSimilarity("Müller", "Mueller")).toBe(100);
  });

  it("92 for a phonetic (Cologne) match", () => {
    expect(calculateCompanyNameSimilarity("Meyer Bau", "Maier Bau")).toBe(92);
    expect(calculateCompanyNameSimilarity("Schmidt", "Schmitt")).toBe(92);
  });

  it("containment scores 75 + coverage * 25", () => {
    // "amazon" (6) inside "amazon europe" (13): 75 + 25*6/13 = 86.53… → 87
    expect(calculateCompanyNameSimilarity("Amazon", "Amazon Europe")).toBe(87);
    // "rewe" (4) inside "rewe group holding" (18): 75 + 25*4/18 = 80.55… → 81
    expect(calculateCompanyNameSimilarity("REWE", "REWE Group Holding")).toBe(81);
  });

  it("falls back to Levenshtein ratio", () => {
    // "amazol" vs "amazon": phonetic codes differ (685 vs 686), no containment
    // → Levenshtein: distance 1, maxLen 6 → (6-1)/6*100 = 83.3 → 83
    expect(calculateCompanyNameSimilarity("Amazol", "Amazon")).toBe(83);
    // "amazoon" vs "amazon" is a PHONETIC match (both code 686) → 92, the
    // Levenshtein branch is never reached
    expect(calculateCompanyNameSimilarity("Amazoon", "Amazon")).toBe(92);
  });

  it("0 when either side normalizes to empty (suffix-only aliases)", () => {
    expect(calculateCompanyNameSimilarity("LLC", "Amazon LLC")).toBe(0);
    expect(calculateCompanyNameSimilarity("Amazon", "")).toBe(0);
  });

  it("phonetic branch requires code length >= 2 (single letters fall through)", () => {
    // "b" vs "p" both code "1" (length 1) → Levenshtein: (1-1)/1 = 0
    expect(calculateCompanyNameSimilarity("b", "p")).toBe(0);
  });
});

// ============================================================================
// 4. Partner matching (matchTransaction) — confidences and ranking
// ============================================================================

const ptx = (o: Partial<PartnerTxData> = {}): PartnerTxData => ({
  id: "t1",
  partner: null,
  partnerIban: null,
  name: "",
  reference: null,
  ...o,
});

const pd = (o: Partial<PartnerData> & { id: string; name: string }): PartnerData => ({
  aliases: [],
  ibans: [],
  ...o,
});

describe("matchTransaction — match sources and exact confidences", () => {
  it("IBAN match is definitive: 100, source 'iban', formatting-insensitive", () => {
    const results = matchTransaction(
      ptx({ partnerIban: "at61 1904 3002 3457 3201" }),
      [pd({ id: "p1", name: "Hetzner", ibans: ["AT611904300234573201"] })],
      []
    );
    expect(results).toEqual([
      { partnerId: "p1", partnerType: "user", partnerName: "Hetzner", confidence: 100, source: "iban" },
    ]);
  });

  it("learned pattern confidence passes through unchanged", () => {
    const results = matchTransaction(
      ptx({ name: "HETZNER.CLOUD INVOICE" }),
      [pd({ id: "p1", name: "Zzz Qqq", learnedPatterns: [{ pattern: "*hetzner*", confidence: 91 }] })],
      []
    );
    expect(results).toEqual([
      { partnerId: "p1", partnerType: "user", partnerName: "Zzz Qqq", confidence: 91, source: "pattern" },
    ]);
  });

  it("learned pattern excludePatterns suppress the pattern match", () => {
    const results = matchTransaction(
      ptx({ name: "PayPal *Foodora Wien" }),
      [
        pd({
          id: "p1",
          name: "Zzz Qqq",
          learnedPatterns: [
            { pattern: "*paypal*", confidence: 95, excludePatterns: ["*foodora*"] },
          ] as PartnerData["learnedPatterns"],
        }),
      ],
      []
    );
    expect(results).toEqual([]);
  });

  it("static pattern 'exclude' list suppresses global-partner pattern matches", () => {
    const results = matchTransaction(
      ptx({ name: "PayPal *Foodora Wien" }),
      [],
      [pd({ id: "g1", name: "Zzz Qqq", patterns: [{ pattern: "*paypal*", confidence: 95, exclude: ["*foodora*"] }] })]
    );
    expect(results).toEqual([]);
  });

  it("website match scores 90", () => {
    const results = matchTransaction(
      ptx({ name: "HETZNER.COM ABBUCHUNG" }),
      [pd({ id: "p1", name: "Zzz Qqq", website: "https://www.hetzner.com/" })],
      []
    );
    expect(results).toEqual([
      { partnerId: "p1", partnerType: "user", partnerName: "Zzz Qqq", confidence: 90, source: "website" },
    ]);
  });

  it("name containment in transaction text scores 86 — below auto-apply", () => {
    const results = matchTransaction(
      ptx({ name: "Kartenzahlung AMAZON EU" }),
      [pd({ id: "p1", name: "Amazon" })],
      []
    );
    // similarity 95 → min(90, 60 + (95-60)*30/40) = 86.25 → 86
    expect(results[0].confidence).toBe(86);
    expect(results[0].source).toBe("name");
    expect(shouldAutoApply(86)).toBe(false);
  });

  // characterization: the containment check compares the RAW lowercased tx
  // text with the umlaut-EXPANDED partner name, so "müller" never contains
  // "mueller". The fuzzy fallback then yields similarity 100 → confidence 90,
  // HIGHER than the 86 an exact ASCII containment gives. Exact umlaut names
  // auto-apply (90 >= 89) while exact ASCII names (86) do not.
  it("exact umlaut name scores 90 (auto), exact ASCII name scores 86 (no auto)", () => {
    const umlaut = matchTransaction(
      ptx({ partner: "Müller" }),
      [pd({ id: "p1", name: "Müller" })],
      []
    );
    expect(umlaut[0].confidence).toBe(90);
    expect(shouldAutoApply(90)).toBe(true);

    const ascii = matchTransaction(
      ptx({ partner: "Amazon" }),
      [pd({ id: "p2", name: "Amazon" })],
      []
    );
    expect(ascii[0].confidence).toBe(86);
    expect(shouldAutoApply(86)).toBe(false);
  });

  it("phonetic-only similarity (92) maps to confidence 84", () => {
    const results = matchTransaction(
      ptx({ partner: "Maier Bau" }),
      [pd({ id: "p1", name: "Meyer Bau" })],
      []
    );
    // 60 + (92-60)*30/40 = 84
    expect(results[0].confidence).toBe(84);
  });

  it("Levenshtein similarity 83 maps to confidence 77", () => {
    const results = matchTransaction(
      ptx({ partner: "Amazol" }),
      [pd({ id: "p1", name: "Amazon" })],
      []
    );
    // 60 + (83-60)*30/40 = 77.25 → 77
    expect(results[0].confidence).toBe(77);
  });

  it("name + alias both matching boosts to 95", () => {
    const results = matchTransaction(
      ptx({ name: "AMZN Amazon Marketplace" }),
      [pd({ id: "p1", name: "Amazon", aliases: ["AMZN"] })],
      []
    );
    // min(95, 92 + (95-60)*0.075) = 94.625 → 95
    expect(results[0].confidence).toBe(95);
    expect(shouldAutoApply(95)).toBe(true);
  });

  // characterization: field checks are else-if chained — when tx.partner is
  // present but dissimilar, the tx.name field is never fuzzy-checked at all.
  it("a present-but-wrong partner field blocks fuzzy matching on the name field", () => {
    const results = matchTransaction(
      ptx({ partner: "XYZ Holdings", name: "Netflik" }),
      [pd({ id: "p1", name: "Netflix" })],
      []
    );
    expect(results).toEqual([]);
  });

  it("names shorter than 3 chars after normalization never match", () => {
    const results = matchTransaction(
      ptx({ partner: "AB" }),
      [pd({ id: "p1", name: "AB" })],
      []
    );
    expect(results).toEqual([]);
  });
});

describe("matchTransaction — ranking and tie-breaking", () => {
  it("user partner above threshold outranks HIGHER-confidence global partner", () => {
    // characterization: when both are >= 89, user type wins regardless of
    // confidence — user@90 is ranked before global@100 (IBAN match).
    const results = matchTransaction(
      ptx({ partner: "Müller", partnerIban: "DE89370400440532013000" }),
      [pd({ id: "u1", name: "Müller" })],
      [pd({ id: "g1", name: "Global Corp", ibans: ["DE89370400440532013000"] })]
    );
    expect(results.map((r) => [r.partnerId, r.confidence])).toEqual([
      ["u1", 90],
      ["g1", 100],
    ]);
  });

  it("a partner above threshold outranks a below-threshold user partner", () => {
    const results = matchTransaction(
      ptx({ name: "Kartenzahlung AMAZON EU" }),
      [pd({ id: "u1", name: "Amazon" })], // 86 (below 89)
      [pd({ id: "g1", name: "Zzz Qqq", patterns: [{ pattern: "*amazon*", confidence: 95 }] })]
    );
    expect(results.map((r) => r.partnerId)).toEqual(["g1", "u1"]);
  });

  it("below threshold, equal confidence ties break in favor of user partners", () => {
    const results = matchTransaction(
      ptx({ partner: "Amazol" }),
      [pd({ id: "u1", name: "Amazon" })], // 77
      [pd({ id: "g1", name: "Amazon" })] // 77
    );
    expect(results.map((r) => [r.partnerId, r.confidence])).toEqual([
      ["u1", 77],
      ["g1", 77],
    ]);
  });

  it("returns at most 3 results, highest confidence first", () => {
    const partners = [95, 94, 93, 92].map((conf, i) =>
      pd({ id: `p${i}`, name: `Zzz ${i}`, learnedPatterns: [{ pattern: "*acme*", confidence: conf }] })
    );
    const results = matchTransaction(ptx({ name: "ACME Corp payment" }), partners, []);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.confidence)).toEqual([95, 94, 93]);
  });

  it("shouldAutoApply threshold is exactly 89", () => {
    expect(shouldAutoApply(89)).toBe(true);
    expect(shouldAutoApply(88)).toBe(false);
    expect(shouldAutoApply(88.9)).toBe(false);
  });
});

// ============================================================================
// 5. Glob / flexible pattern matching (pattern-utils)
// ============================================================================

describe("globMatch — anchoring, escaping, umlauts", () => {
  it("matches are anchored to the full text", () => {
    expect(globMatch("amazon", "amazon")).toBe(true);
    expect(globMatch("amazon", "amazon prime")).toBe(false);
    expect(globMatch("amazon*", "amazon prime")).toBe(true);
    expect(globMatch("*prime", "amazon prime")).toBe(true);
  });

  it("is case-insensitive via normalizeUmlauts lowercasing", () => {
    expect(globMatch("AMAZON*", "Amazon Prime")).toBe(true);
  });

  it("escapes regex metacharacters (only * is a wildcard)", () => {
    expect(globMatch("amazon.de", "amazon.de")).toBe(true);
    expect(globMatch("amazon.de", "amazonxde")).toBe(false);
    expect(globMatch("c++*", "c++ kurs")).toBe(true);
    expect(globMatch("(test)*", "(test) abc")).toBe(true);
  });

  it("normalizes umlauts on BOTH pattern and text (ä→ae, ß→ss)", () => {
    expect(globMatch("*müller*", "MUELLER GMBH")).toBe(true);
    expect(globMatch("*mueller*", "Müller")).toBe(true);
    expect(globMatch("*straße*", "STRASSE 5")).toBe(true);
    expect(normalizeUmlauts("Äöüß")).toBe("aeoeuess");
  });

  // characterization: empty text returns false even for the match-anything
  // pattern "*".
  it("empty pattern or empty text always fails", () => {
    expect(globMatch("", "x")).toBe(false);
    expect(globMatch("*", "")).toBe(false);
    expect(globMatch("*", "a")).toBe(true);
  });
});

describe("matchPatternFlexible — field combination orderings", () => {
  it("matches a pattern spanning name+partner in either order", () => {
    expect(matchPatternFlexible("*rewe*wien*", "REWE Dankt", "Wien Mitte", null)).toBe(true);
    expect(matchPatternFlexible("*wien*rewe*", "REWE Dankt", "Wien Mitte", null)).toBe(true);
  });

  it("matches a pattern spanning name+reference via the all-fields combo", () => {
    expect(matchPatternFlexible("*rewe*ref9*", "REWE", null, "REF9")).toBe(true);
  });

  it("returns false when all fields are null/empty", () => {
    expect(matchPatternFlexible("*x*", null, null, null)).toBe(false);
  });
});

// ============================================================================
// 6. Transaction scoring — uncovered exact behaviors
// ============================================================================

describe("calculateAmountScore — tolerance asymmetry and boundaries", () => {
  it("boundaries: 1% → 38, 5% → 30, 10% → 20, >10% → 0", () => {
    expect(calculateAmountScore(100, 101).score).toBe(38);
    expect(calculateAmountScore(100, 105).score).toBe(30);
    expect(calculateAmountScore(100, 110).score).toBe(20);
    expect(calculateAmountScore(100, 111).score).toBe(0);
  });

  // characterization: the tolerance is derived from the FILE amount only, so
  // scoring is asymmetric — (file=100, tx=111) fails but (file=111, tx=100)
  // passes the 10% band.
  it("is asymmetric: (100,111) → 0 but (111,100) → 20", () => {
    expect(calculateAmountScore(100, 111).score).toBe(0);
    expect(calculateAmountScore(111, 100).score).toBe(20);
  });

  it("currency mismatch halves then rounds: 38→19, 30→15, 20→10, 40→20", () => {
    expect(calculateAmountScore(100, 101, "USD", "EUR").score).toBe(19);
    expect(calculateAmountScore(100, 105, "USD", "EUR").score).toBe(15);
    expect(calculateAmountScore(100, 110, "USD", "EUR").score).toBe(10);
    expect(calculateAmountScore(100, 100, "USD", "EUR").score).toBe(20);
  });

  it("currency comparison is case-insensitive", () => {
    const r = calculateAmountScore(100, 100, "eur", "EUR");
    expect(r.currencyMismatch).toBe(false);
    expect(r.score).toBe(40);
  });
});

describe("calculateDateScore — sub-day floor asymmetry", () => {
  // characterization: daysDiff = abs(floor(file - tx)), so a transaction 12h
  // AFTER the file date floors to -1 (score 22) while 12h BEFORE floors to 0
  // (score 25). Same absolute distance, different score.
  it("same 12h distance scores 25 or 22 depending on direction", () => {
    const early = new Date("2024-06-15T00:00:00Z");
    const late = new Date("2024-06-15T12:00:00Z");
    expect(calculateDateScore(late, early).score).toBe(25); // file after tx
    expect(calculateDateScore(early, late).score).toBe(22); // file before tx
  });
});

describe("calculateReferenceScore", () => {
  it("requires reference length >= 3", () => {
    expect(calculateReferenceScore("text with ab inside", "ab", 0)).toEqual({
      score: 0,
      dateBonus: 0,
      source: null,
    });
  });

  it("case-insensitive containment scores 5 with a 10-point date bonus when date < 15", () => {
    expect(calculateReferenceScore("Rechnung RG-2024-001 vom Juni", "rg-2024-001", 8)).toEqual({
      score: 5,
      dateBonus: 10,
      source: "reference",
    });
    // date score 15 or above → no bonus
    expect(calculateReferenceScore("Rechnung RG-2024-001 vom Juni", "rg-2024-001", 15).dateBonus).toBe(0);
  });
});

describe("scoreTransaction — composite behaviors", () => {
  const baseTx = (o: Partial<ScoringTxData> = {}): ScoringTxData => ({
    id: "tx-1",
    amount: -100,
    date: ts("2024-06-15"),
    currency: "EUR",
    ...o,
  });

  it("IBAN match adds exactly 10 (formatting-insensitive)", () => {
    const result = scoreTransaction(
      { extractedIban: "de89 3704 0044 0532 0130 00" },
      baseTx({ partnerIban: "DE89370400440532013000" })
    );
    expect(result.breakdown.iban).toBe(10);
    expect(result.confidence).toBe(10);
    expect(result.matchSources).toEqual(["iban"]);
  });

  // characterization: the reference date-bonus mutates breakdown.date even
  // when the file has NO extracted date at all — breakdown.date becomes 10
  // without any date_* match source.
  it("reference date-bonus writes 10 into breakdown.date with no date match", () => {
    const result = scoreTransaction(
      { extractedText: "Rechnung RG-2024-001" },
      baseTx({ reference: "RG-2024-001" })
    );
    expect(result.breakdown.reference).toBe(5);
    expect(result.breakdown.date).toBe(10);
    expect(result.matchSources).toEqual(["reference"]);
    expect(result.confidence).toBe(15);
  });

  it("reference bonus tops up a weak date score: 8 → 18", () => {
    const result = scoreTransaction(
      { extractedDate: ts("2024-06-05"), extractedText: "Rechnung RG-2024-001" },
      baseTx({ date: ts("2024-06-15"), reference: "RG-2024-001" })
    );
    expect(result.breakdown.date).toBe(18); // 8 + 10, capped at 25
    expect(result.breakdown.reference).toBe(5);
    expect(result.confidence).toBe(23);
  });

  describe("precision hint tiers", () => {
    const hint = (matchConfidence?: number) =>
      scoreTransaction(
        { precisionSearchHint: { transactionId: "tx-1", ...(matchConfidence !== undefined ? { matchConfidence } : {}) } },
        baseTx()
      ).breakdown.hint;

    it("confidence >= 50 → 40; >= 25 → 30; below → 25", () => {
      expect(hint(50)).toBe(40);
      expect(hint(80)).toBe(40);
      expect(hint(49)).toBe(30);
      expect(hint(25)).toBe(30);
      expect(hint(24)).toBe(25);
    });

    // characterization: matchConfidence 0 is falsy, so it falls into the
    // default 25 tier instead of being treated as "below 25".
    it("confidence 0 and missing confidence both score 25", () => {
      expect(hint(0)).toBe(25);
      expect(hint(undefined)).toBe(25);
    });

    it("only applies when the hint's transactionId matches", () => {
      const result = scoreTransaction(
        { precisionSearchHint: { transactionId: "other-tx", matchConfidence: 90 } },
        baseTx()
      );
      expect(result.breakdown.hint).toBe(0);
    });
  });

  describe("partner-date boost/penalty exact values", () => {
    const filePartner: FileMatchingData = { partnerId: "p1", extractedDate: ts("2024-06-15") };
    const txPartner = (date: string) => baseTx({ date: ts(date), partnerId: "p1" });

    it("date 22 boosts to 33; date 15 boosts to 23; exact date caps at 37", () => {
      expect(scoreTransaction(filePartner, txPartner("2024-06-13")).breakdown.date).toBe(33); // 22*1.5
      expect(scoreTransaction(filePartner, txPartner("2024-06-10")).breakdown.date).toBe(23); // round(22.5)
      // characterization: 25*1.5 = 37.5 rounds to 38 but the cap keeps it 37
      expect(scoreTransaction(filePartner, txPartner("2024-06-15")).breakdown.date).toBe(37);
    });

    it("date score 3 (15-30 days) penalizes partner 25 → 15", () => {
      const result = scoreTransaction(filePartner, txPartner("2024-07-05"));
      expect(result.breakdown.date).toBe(3);
      expect(result.breakdown.partner).toBe(15);
    });

    it("date score 0 (>30 days) penalizes a contains-match partner 18 → 11", () => {
      const result = scoreTransaction(
        { extractedPartner: "Amazon", extractedDate: ts("2024-01-01") },
        baseTx({ date: ts("2024-06-15"), name: "Amazon EU S.a.r.l." })
      );
      expect(result.breakdown.partner).toBe(11); // round(18 * 0.6)
    });

    it("partner score below 15 is never penalized", () => {
      // 1-word overlap with short names → partner score 12
      const result = scoreTransaction(
        { extractedPartner: "Amazon Payments", extractedDate: ts("2024-06-01") },
        baseTx({ date: ts("2024-06-25"), name: "Amazon Locker" })
      );
      expect(result.breakdown.partner).toBe(12);
      expect(result.breakdown.date).toBe(3);
    });
  });

  it("weights multiply the BOOSTED date score; breakdown stays unweighted", () => {
    const result = scoreTransaction(
      { partnerId: "p1", extractedDate: ts("2024-06-15") },
      baseTx({ date: ts("2024-06-15"), partnerId: "p1" }),
      undefined,
      { weights: { amountWeight: 1, dateWeight: 2, partnerWeight: 1 } }
    );
    // date 25 → boost 37, weighted 74; partner 25 → confidence 99
    expect(result.breakdown.date).toBe(37);
    expect(result.breakdown.partner).toBe(25);
    expect(result.confidence).toBe(99);
  });

  it("weights do NOT apply to iban, reference, or hint scores", () => {
    const result = scoreTransaction(
      {
        extractedIban: "DE89370400440532013000",
        extractedText: "Rechnung RG-2024-001",
        precisionSearchHint: { transactionId: "tx-1", matchConfidence: 90 },
      },
      baseTx({ partnerIban: "DE89370400440532013000", reference: "RG-2024-001" }),
      undefined,
      { weights: { amountWeight: 0, dateWeight: 0, partnerWeight: 0 } }
    );
    // iban 10 + ref 5 + hint 40 = 55; the ref date-bonus (10) IS zeroed by dateWeight 0
    expect(result.breakdown.iban).toBe(10);
    expect(result.breakdown.reference).toBe(5);
    expect(result.breakdown.hint).toBe(40);
    expect(result.confidence).toBe(55);
  });

  it("preview defaults: currency EUR, empty name, null partner", () => {
    const result = scoreTransaction({}, baseTx({ currency: undefined, name: undefined, partner: undefined }));
    expect(result.preview.currency).toBe("EUR");
    expect(result.preview.name).toBe("");
    expect(result.preview.partner).toBeNull();
  });
});

describe("normalizeName / namesMatch quirks (transactionScoring)", () => {
  // characterization: unlike normalizeCompanyName, this suffix regex is NOT
  // anchored to the end of the string, so suffix tokens are stripped from the
  // MIDDLE of words ("ag" in Wagner, "co" in Costco/Consulting).
  it("strips suffix tokens mid-word: Wagner → 'w ner'", () => {
    expect(normalizeName("Wagner")).toBe("w ner");
  });

  it("Costco → 'st' (both 'co' tokens removed)", () => {
    expect(normalizeName("Costco")).toBe("st");
  });

  it("Hamburg Consulting → 'hamburg nsulting'", () => {
    expect(normalizeName("Hamburg Consulting")).toBe("hamburg nsulting");
  });

  it("namesMatch still sees mangled-but-equal names as exact (25)", () => {
    expect(namesMatch("Wagner", "Wagner GmbH")).toEqual({ match: true, score: 25 });
  });

  it("single-word overlap with short names scores 12", () => {
    expect(namesMatch("Amazon Payments", "Amazon Locker")).toEqual({ match: true, score: 12 });
  });
});

// ============================================================================
// 7. Category matching — exact confidences, boosts, rule precedence
// ============================================================================

const cat = (o: Partial<CategoryData> = {}): CategoryData => ({
  id: "c1",
  userId: "u1",
  templateId: "private-personal",
  name: "Private",
  matchedPartnerIds: [],
  transactionCount: 0,
  isActive: true,
  ...o,
});

const ctxTx = (o: Partial<CategoryTxData> = {}): CategoryTxData => ({
  id: "t1",
  partner: null,
  partnerId: "p1",
  name: "",
  reference: null,
  noReceiptCategoryId: null,
  fileIds: [],
  ...o,
});

const rule = (o: Partial<CategoryMatchRule> = {}): CategoryMatchRule => ({
  categoryId: "c1",
  categoryTemplateId: "private-personal",
  patterns: [],
  confidence: 70,
  createdAt: Timestamp.now(),
  updatedAt: Timestamp.now(),
  sourceTransactionIds: [],
  ...o,
});

describe("matchTransactionToCategories — exact confidences", () => {
  it("legacy partner match scores exactly 89 and auto-applies (89 >= 89)", () => {
    const suggestions = matchTransactionToCategories(ctxTx(), [cat({ matchedPartnerIds: ["p1"] })]);
    expect(suggestions).toEqual([
      { categoryId: "c1", templateId: "private-personal", confidence: 89, source: "partner" },
    ]);
    expect(shouldAutoApplyCategory(89)).toBe(true);
    expect(shouldAutoApplyCategory(88.9)).toBe(false);
  });

  it("usage boost is logarithmic and UNROUNDED: count 10 → 89 + log10(11)*5", () => {
    const suggestions = matchTransactionToCategories(
      ctxTx(),
      [cat({ matchedPartnerIds: ["p1"], transactionCount: 10 })]
    );
    // characterization: confidence is a float (94.2069…), never rounded
    expect(suggestions[0].confidence).toBe(89 + Math.log10(11) * 5);
  });

  it("usage boost caps at 10; total confidence caps at 100", () => {
    const suggestions = matchTransactionToCategories(
      ctxTx(),
      [cat({ matchedPartnerIds: ["p1"], transactionCount: 1000 })],
      undefined,
      { partnerFilePatternCounts: new Map([["p1", 0]]) }
    );
    // 89 + 10 (capped usage) + 8 (no file patterns) = 107 → 100
    expect(suggestions[0].confidence).toBe(100);
  });

  it("no-file-patterns boost (+8) only when partner is in the map with count 0", () => {
    const withZero = matchTransactionToCategories(
      ctxTx(),
      [cat({ matchedPartnerIds: ["p1"] })],
      undefined,
      { partnerFilePatternCounts: new Map([["p1", 0]]) }
    );
    expect(withZero[0].confidence).toBe(97); // 89 + 8

    const notInMap = matchTransactionToCategories(
      ctxTx(),
      [cat({ matchedPartnerIds: ["p1"] })],
      undefined,
      { partnerFilePatternCounts: new Map([["other", 0]]) }
    );
    expect(notInMap[0].confidence).toBe(89);

    const withPatterns = matchTransactionToCategories(
      ctxTx(),
      [cat({ matchedPartnerIds: ["p1"] })],
      undefined,
      { partnerFilePatternCounts: new Map([["p1", 3]]) }
    );
    expect(withPatterns[0].confidence).toBe(89);
  });

  // characterization: the code comment says "up to +9 at 95% confidence" but
  // Math.round(95 * 0.1) = 10, so a 95% no_receipt preference adds +10.
  it("resolution preference no_receipt@95 adds +10 (not +9)", () => {
    const suggestions = matchTransactionToCategories(
      ctxTx(),
      [cat({ matchedPartnerIds: ["p1"] })],
      undefined,
      {
        partnerResolutionPreferences: new Map([
          ["p1", {
            type: "no_receipt" as const,
            confidence: 95,
            stats: { fileCount: 0, noReceiptCount: 10, updatedAt: Timestamp.now() },
          }],
        ]),
      }
    );
    expect(suggestions[0].confidence).toBe(99);
  });

  it("resolution preference of other types adds nothing", () => {
    const suggestions = matchTransactionToCategories(
      ctxTx(),
      [cat({ matchedPartnerIds: ["p1"] })],
      undefined,
      {
        partnerResolutionPreferences: new Map([
          ["p1", {
            type: "file_required" as const,
            confidence: 95,
            stats: { fileCount: 10, noReceiptCount: 0, updatedAt: Timestamp.now() },
          }],
        ]),
      }
    );
    expect(suggestions[0].confidence).toBe(89);
  });
});

describe("matchTransactionToCategories — partner rules precedence", () => {
  it("matching rule wins over legacy and uses the rule's confidence", () => {
    const suggestions = matchTransactionToCategories(
      ctxTx({ name: "YouTube Premium" }),
      [cat({ matchedPartnerIds: ["p1"] })],
      undefined,
      { partnerCategoryRules: [rule({ patterns: ["*youtube*"], confidence: 70 })] }
    );
    expect(suggestions).toEqual([
      { categoryId: "c1", templateId: "private-personal", confidence: 70, source: "partner_rule" },
    ]);
  });

  it("non-matching rule blocks the legacy fallback entirely", () => {
    const suggestions = matchTransactionToCategories(
      ctxTx({ name: "Google Cloud" }),
      [cat({ matchedPartnerIds: ["p1"] })],
      undefined,
      { partnerCategoryRules: [rule({ patterns: ["*youtube*"], confidence: 70 })] }
    );
    expect(suggestions).toEqual([]);
  });

  it("excludePatterns veto the category even when a positive pattern matches", () => {
    const suggestions = matchTransactionToCategories(
      ctxTx({ name: "YouTube Premium" }),
      [cat({ matchedPartnerIds: ["p1"] })],
      undefined,
      {
        partnerCategoryRules: [
          rule({ patterns: ["*youtube*"], excludePatterns: ["*premium*"], confidence: 70 }),
        ],
      }
    );
    expect(suggestions).toEqual([]);
  });

  // characterization: a rule with an EMPTY patterns array is treated as "no
  // rule matched" without blocking, so the legacy 89% path still applies.
  it("rule with empty patterns array falls through to the legacy 89% match", () => {
    const suggestions = matchTransactionToCategories(
      ctxTx({ name: "Anything" }),
      [cat({ matchedPartnerIds: ["p1"] })],
      undefined,
      { partnerCategoryRules: [rule({ patterns: [], confidence: 70 })] }
    );
    expect(suggestions[0]).toMatchObject({ confidence: 89, source: "partner" });
  });

  it("rule for a different category leaves legacy matching untouched", () => {
    const suggestions = matchTransactionToCategories(
      ctxTx({ name: "Anything" }),
      [cat({ matchedPartnerIds: ["p1"] })],
      undefined,
      { partnerCategoryRules: [rule({ categoryId: "other-cat", patterns: ["*x*"], confidence: 70 })] }
    );
    expect(suggestions[0]).toMatchObject({ confidence: 89, source: "partner" });
  });

  it("suggestion threshold 60: rule@55 fails alone but passes with usage boost", () => {
    const alone = matchTransactionToCategories(
      ctxTx({ name: "YouTube Premium" }),
      [cat()],
      undefined,
      { partnerCategoryRules: [rule({ patterns: ["*youtube*"], confidence: 55 })] }
    );
    expect(alone).toEqual([]);

    const boosted = matchTransactionToCategories(
      ctxTx({ name: "YouTube Premium" }),
      [cat({ transactionCount: 10 })],
      undefined,
      { partnerCategoryRules: [rule({ patterns: ["*youtube*"], confidence: 55 })] }
    );
    expect(boosted[0].confidence).toBe(55 + Math.log10(11) * 5); // 60.2069…
  });
});

describe("matchTransactionToCategories — eligibility and filtering", () => {
  it("skips receipt-lost and inactive categories", () => {
    expect(
      matchTransactionToCategories(ctxTx(), [
        cat({ templateId: "receipt-lost", matchedPartnerIds: ["p1"] }),
        cat({ id: "c2", isActive: false, matchedPartnerIds: ["p1"] }),
      ])
    ).toEqual([]);
  });

  it("skips categories the transaction was manually removed from", () => {
    const removals = new Map([["c1", new Set(["t1"])]]);
    expect(
      matchTransactionToCategories(ctxTx(), [cat({ matchedPartnerIds: ["p1"] })], removals)
    ).toEqual([]);
  });

  it("returns nothing without a partnerId", () => {
    expect(
      matchTransactionToCategories(ctxTx({ partnerId: null }), [cat({ matchedPartnerIds: ["p1"] })])
    ).toEqual([]);
  });

  it("sorts by confidence desc and returns at most 3", () => {
    const categories = [
      cat({ id: "c-0", transactionCount: 0, matchedPartnerIds: ["p1"] }),
      cat({ id: "c-5", transactionCount: 5, matchedPartnerIds: ["p1"] }),
      cat({ id: "c-10", transactionCount: 10, matchedPartnerIds: ["p1"] }),
      cat({ id: "c-100", transactionCount: 100, matchedPartnerIds: ["p1"] }),
    ];
    const suggestions = matchTransactionToCategories(ctxTx(), categories);
    expect(suggestions.map((s) => s.categoryId)).toEqual(["c-100", "c-10", "c-5"]);
  });

  it("isEligibleForCategoryMatching: category or files disqualify", () => {
    expect(isEligibleForCategoryMatching(ctxTx())).toBe(true);
    expect(isEligibleForCategoryMatching(ctxTx({ noReceiptCategoryId: "c1" }))).toBe(false);
    expect(isEligibleForCategoryMatching(ctxTx({ fileIds: ["f1"] }))).toBe(false);
  });
});

// ============================================================================
// 8. Pattern learning pipeline (patternEngine.learnPatterns, fake Gemini)
// ============================================================================

function aiResponse(text: string | null, inTok = 100, outTok = 20) {
  return {
    response: {
      usageMetadata: { promptTokenCount: inTok, candidatesTokenCount: outTok },
      candidates: text == null ? [] : [{ content: { parts: [{ text }] } }],
    },
  };
}

function fakeModel(responses: Array<ReturnType<typeof aiResponse>>) {
  const prompts: string[] = [];
  const model = {
    generateContent: async (req: { contents: Array<{ parts: Array<{ text: string }> }> }) => {
      prompts.push(req.contents[0].parts[0].text);
      const next = responses.shift();
      if (!next) throw new Error("fake model: no more scripted responses");
      return next;
    },
  } as unknown as GenerativeModel;
  return { model, prompts };
}

const sample = (id: string, name: string, partner: string | null = null, reference: string | null = null): TxSample =>
  ({ id, name, partner, reference });

function engineInput(
  model: GenerativeModel,
  overrides: Partial<PatternLearningInput> = {}
): PatternLearningInput {
  const positives = [
    sample("a1", "AMAZON.DE Bestellung"),
    sample("a2", "Lastschrift", "AMAZON EU SARL"),
  ];
  return {
    targetName: "Amazon",
    targetAliases: [],
    positiveTransactions: positives,
    negativeTransactions: [],
    collisionTransactions: [],
    allUserTransactions: [...positives, sample("o1", "REWE Wien"), sample("o2", "Billa Dankt")],
    totalTransactionCount: 10,
    model,
    ownerId: "p-amazon",
    ...overrides,
  };
}

describe("learnPatterns pipeline (scripted AI)", () => {
  it("lowercases, rounds confidence, drops <50, strips ```json fences, applies adjustedConfidence", async () => {
    const gen = '```json\n{"patterns":[' +
      '{"pattern":"*AMAZON*","confidence":95.6,"reasoning":"r"},' +
      '{"pattern":"*weak*","confidence":49,"reasoning":"r"}]}\n```';
    const verify = '{"verified":[{"pattern":"*amazon*","approved":true,"adjustedConfidence":97}]}';
    const { model } = fakeModel([aiResponse(gen, 100, 20), aiResponse(verify, 50, 10)]);

    const result = await learnPatterns(engineInput(model));

    expect(result.patterns).toEqual([{ pattern: "*amazon*", confidence: 97 }]);
    expect(result.aiUsage).toEqual({ inputTokens: 150, outputTokens: 30, calls: 2 });
  });

  it("rejects patterns matching a false-positive (manual removal) before dry-run", async () => {
    const gen = '{"patterns":[' +
      '{"pattern":"*paypal*","confidence":90,"reasoning":"r"},' +
      '{"pattern":"*amazon*","confidence":92,"reasoning":"r"}]}';
    const verify = '{"verified":[{"pattern":"*amazon*","approved":true}]}';
    const { model } = fakeModel([aiResponse(gen), aiResponse(verify)]);

    const result = await learnPatterns(
      engineInput(model, {
        negativeTransactions: [sample("n1", "Zahlung", "PayPal Foodora")],
      })
    );
    expect(result.patterns).toEqual([{ pattern: "*amazon*", confidence: 92 }]);
  });

  it("catastrophic safety (>50% match, source ratio <0.3) rejects without a verification call", async () => {
    const all = [
      sample("p1", "PAY x1"), sample("x2", "PAY x2"), sample("x3", "PAY x3"),
      sample("x4", "PAY x4"), sample("x5", "PAY x5"), sample("x6", "PAY x6"),
      sample("x7", "REWE"), sample("x8", "Billa"), sample("x9", "Spar"), sample("x10", "Hofer"),
    ];
    const gen = '{"patterns":[{"pattern":"*pay*","confidence":90,"reasoning":"r"}]}';
    const { model, prompts } = fakeModel([aiResponse(gen)]);

    const result = await learnPatterns(
      engineInput(model, {
        positiveTransactions: [all[0]],
        allUserTransactions: all,
        totalTransactionCount: 10,
      })
    );
    expect(result.patterns).toEqual([]);
    // characterization: pipeline stops before verification — only 1 AI call
    expect(result.aiUsage.calls).toBe(1);
    expect(prompts).toHaveLength(1);
  });

  it("verification rejection removes the pattern; unmentioned patterns are kept", async () => {
    const positives = [sample("a1", "AMAZON.DE"), sample("a2", "AMZN Marketplace")];
    const gen = '{"patterns":[' +
      '{"pattern":"*amazon*","confidence":90,"reasoning":"r"},' +
      '{"pattern":"amzn*","confidence":80,"reasoning":"r"}]}';
    // Only *amazon* is mentioned; amzn* must be kept as-is
    const verify = '{"verified":[{"pattern":"*amazon*","approved":true}]}';
    const { model } = fakeModel([aiResponse(gen), aiResponse(verify)]);

    const result = await learnPatterns(
      engineInput(model, {
        positiveTransactions: positives,
        allUserTransactions: positives,
      })
    );
    expect(result.patterns).toEqual([
      { pattern: "*amazon*", confidence: 90 },
      { pattern: "amzn*", confidence: 80 },
    ]);
  });

  it("rejected-by-verification patterns are dropped", async () => {
    const gen = '{"patterns":[{"pattern":"*amazon*","confidence":90,"reasoning":"r"}]}';
    const verify = '{"verified":[{"pattern":"*amazon*","approved":false,"reason":"too broad"}]}';
    const { model } = fakeModel([aiResponse(gen), aiResponse(verify)]);

    const result = await learnPatterns(engineInput(model));
    expect(result.patterns).toEqual([]);
    expect(result.aiUsage.calls).toBe(2);
  });

  it("malformed verification JSON keeps all safe patterns unchanged", async () => {
    const gen = '{"patterns":[{"pattern":"*amazon*","confidence":90,"reasoning":"r"}]}';
    const { model } = fakeModel([aiResponse(gen), aiResponse("sorry, not json")]);

    const result = await learnPatterns(engineInput(model));
    expect(result.patterns).toEqual([{ pattern: "*amazon*", confidence: 90 }]);
  });

  // characterization: adjustedConfidence from verification is applied RAW —
  // it is never clamped to 100 like generation confidences are.
  it("adjustedConfidence above 100 is stored unclamped", async () => {
    const gen = '{"patterns":[{"pattern":"*amazon*","confidence":90,"reasoning":"r"}]}';
    const verify = '{"verified":[{"pattern":"*amazon*","approved":true,"adjustedConfidence":120}]}';
    const { model } = fakeModel([aiResponse(gen), aiResponse(verify)]);

    const result = await learnPatterns(engineInput(model));
    expect(result.patterns).toEqual([{ pattern: "*amazon*", confidence: 120 }]);
  });

  it("generation confidence IS clamped to 100 and excludePatterns are lowercased", async () => {
    const gen = '{"patterns":[{"pattern":"*AmaZon*","confidence":150,"reasoning":"r","excludePatterns":["*FOODORA*"]}]}';
    // Empty verification response → verifyText undefined → keep safe patterns
    const { model } = fakeModel([aiResponse(gen), aiResponse(null)]);

    const result = await learnPatterns(engineInput(model));
    expect(result.patterns).toEqual([
      { pattern: "*amazon*", confidence: 100, excludePatterns: ["*foodora*"] },
    ]);
  });

  it("coverage retry adds only patterns that cover the uncovered positives", async () => {
    const positives = [sample("a1", "Netflix.com"), sample("a2", "Spotify AB")];
    const gen = '{"patterns":[{"pattern":"*netflix*","confidence":95,"reasoning":"r"}]}';
    const verify = '{"verified":[{"pattern":"*netflix*","approved":true}]}';
    const retry = '{"patterns":[' +
      '{"pattern":"*spotify*","confidence":92,"reasoning":"r"},' +
      '{"pattern":"*unrelated*","confidence":91,"reasoning":"r"},' +
      '{"pattern":"*weak2*","confidence":40,"reasoning":"r"}]}';
    const { model, prompts } = fakeModel([aiResponse(gen), aiResponse(verify), aiResponse(retry)]);

    const result = await learnPatterns(
      engineInput(model, {
        targetName: "Streaming",
        positiveTransactions: positives,
        allUserTransactions: positives,
      })
    );
    // *unrelated* covers nothing → dropped; *weak2* < 50 → dropped
    expect(result.patterns).toEqual([
      { pattern: "*netflix*", confidence: 95 },
      { pattern: "*spotify*", confidence: 92 },
    ]);
    expect(result.aiUsage.calls).toBe(3);
    expect(prompts[2]).toContain("NOT matched by any of those patterns");
  });

  it("no coverage retry with a single positive transaction", async () => {
    const positives = [sample("a1", "Netflix.com")];
    const gen = '{"patterns":[{"pattern":"*hulu*","confidence":95,"reasoning":"r"}]}';
    const verify = '{"verified":[{"pattern":"*hulu*","approved":true}]}';
    const { model, prompts } = fakeModel([aiResponse(gen), aiResponse(verify)]);

    const result = await learnPatterns(
      engineInput(model, {
        positiveTransactions: positives,
        allUserTransactions: positives,
      })
    );
    // characterization: pattern does not even match the single positive, but
    // coverage retry requires positiveTransactions.length > 1 — kept as-is.
    expect(result.patterns).toEqual([{ pattern: "*hulu*", confidence: 95 }]);
    expect(prompts).toHaveLength(2);
  });

  it("empty/garbage generation responses return no patterns after 1 call", async () => {
    for (const text of [null, "not json at all", '{"patterns":[]}']) {
      const { model } = fakeModel([aiResponse(text)]);
      const result = await learnPatterns(engineInput(model));
      expect(result.patterns).toEqual([]);
      expect(result.aiUsage.calls).toBe(1);
    }
  });
});

describe("formatTxFields", () => {
  it("formats partner/name and appends reference only when present", () => {
    expect(formatTxFields({ partner: "Amazon", name: "Bestellung" })).toBe(
      'partner: "Amazon" | name: "Bestellung"'
    );
    expect(formatTxFields({ partner: null, name: "Bestellung", reference: "R-1" })).toBe(
      'partner: "(empty)" | name: "Bestellung" | reference: "R-1"'
    );
  });

  // characterization: empty-string partner is falsy → rendered as "(empty)"
  it("empty-string partner renders as (empty)", () => {
    expect(formatTxFields({ partner: "", name: "X" })).toBe('partner: "(empty)" | name: "X"');
  });
});
