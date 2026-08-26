/**
 * Regression tests for fork #71: partner auto-assign fired on Cologne-phonetic
 * hash collisions — a Revolut payment to "esim.me" was auto-assigned the
 * preset "S IMMO AG" at 94%, and "Uber" ranked "Bayer AG" / "PORR AG" above
 * "Uber Technologies, Inc.".
 *
 * Two defects compounded:
 *  1. the phonetic guard accepted 2-digit Cologne codes ("17", "86");
 *  2. the name+alias branch had a floor (92) above the auto-apply gate (89).
 */

import { describe, it, expect } from "vitest";
import {
  ALIAS_AGREEMENT_BONUS,
  AUTO_APPLY_THRESHOLD,
  GLOBAL_APPROXIMATE_NAME_CAP,
  MIN_PHONETIC_CODE_LENGTH,
  MIN_PHONETIC_SPELLING_SIMILARITY,
  PHONETIC_MATCH_SIMILARITY,
  calculateCompanyNameSimilarity,
  colognePhonetic,
  matchTransaction,
  nameMatchConfidence,
  shouldAutoApply,
  PartnerData,
  TransactionData,
} from "../../utils/partner-matcher";
import {
  MIN_PHONETIC_CODE_LENGTH as CLIENT_MIN_PHONETIC_CODE_LENGTH,
  MIN_PHONETIC_SPELLING_SIMILARITY as CLIENT_MIN_PHONETIC_SPELLING_SIMILARITY,
  calculateCompanyNameSimilarity as clientSimilarity,
} from "../../../../lib/matching/fuzzy-match";

const tx = (o: Partial<TransactionData>): TransactionData => ({
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

// The live preset rows from lib/data/preset-partners.ts
const S_IMMO = pd({ id: "preset_s_immo_ag", name: "S IMMO AG", aliases: ["S IMMO"], website: "simmoag.at" });
const BAYER = pd({ id: "preset_bayer_ag", name: "Bayer AG", aliases: ["Bayer"], website: "bayer.com" });
const PORR = pd({ id: "preset_porr_ag", name: "PORR AG", aliases: ["PORR"], website: "porr-group.com" });
const UBER = pd({
  id: "preset_uber_technologies_inc",
  name: "Uber Technologies, Inc.",
  aliases: ["Uber", "Uber Eats", "Uber B.V."],
  website: "uber.com",
});

describe("Cologne phonetic guard (fork #71 defect 1)", () => {
  it("the live collisions really do share short codes", () => {
    expect(colognePhonetic("esim me")).toBe("86");
    expect(colognePhonetic("s immo")).toBe("86");
    expect(colognePhonetic("uber")).toBe("17");
    expect(colognePhonetic("bayer")).toBe("17");
    expect(colognePhonetic("porr")).toBe("17");
  });

  it("esim.me is not a phonetic match for S IMMO AG", () => {
    expect(calculateCompanyNameSimilarity("esim.me", "S IMMO AG")).toBeLessThan(60);
  });

  it("Uber is not a phonetic match for Bayer AG or PORR AG", () => {
    expect(calculateCompanyNameSimilarity("Uber", "Bayer AG")).toBeLessThan(60);
    expect(calculateCompanyNameSimilarity("Uber", "PORR AG")).toBeLessThan(60);
  });

  it("Uber / Uber Technologies, Inc. scores 81 (containment) and outranks the collisions", () => {
    const right = calculateCompanyNameSimilarity("Uber", "Uber Technologies, Inc.");
    expect(right).toBe(81);
    expect(right).toBeGreaterThan(calculateCompanyNameSimilarity("Uber", "Bayer AG"));
    expect(right).toBeGreaterThan(calculateCompanyNameSimilarity("Uber", "PORR AG"));
  });

  it("genuine phonetic variants still score 92", () => {
    expect(calculateCompanyNameSimilarity("Meyer Bau", "Maier Bau")).toBe(PHONETIC_MATCH_SIMILARITY);
    expect(calculateCompanyNameSimilarity("Schmidt", "Schmitt")).toBe(PHONETIC_MATCH_SIMILARITY);
    expect(calculateCompanyNameSimilarity("Amazoon", "Amazon")).toBe(PHONETIC_MATCH_SIMILARITY);
  });

  it("an equal code of length >= 3 is still rejected when the spelling barely overlaps", () => {
    // "Bahnhof" and "Panov" both code to 163; Levenshtein ratio 43 (< 50).
    expect(colognePhonetic("Bahnhof")).toBe("163");
    expect(colognePhonetic("Panov")).toBe("163");
    expect(calculateCompanyNameSimilarity("Bahnhof", "Panov")).toBeLessThan(60);
  });

  it("the client-side mirror uses the same guard constants (drift check)", () => {
    expect(CLIENT_MIN_PHONETIC_CODE_LENGTH).toBe(MIN_PHONETIC_CODE_LENGTH);
    expect(CLIENT_MIN_PHONETIC_SPELLING_SIMILARITY).toBe(MIN_PHONETIC_SPELLING_SIMILARITY);
  });

  it("the client-side mirror applies the same guard", () => {
    expect(clientSimilarity("esim.me", "S IMMO AG")).toBeLessThan(60);
    expect(clientSimilarity("Uber", "Bayer AG")).toBeLessThan(60);
    expect(clientSimilarity("Schmidt", "Schmitt")).toBe(92);
  });
});

describe("name + alias agreement (fork #71 defect 2)", () => {
  it("bonus is bounded so a phonetic-only name+alias match cannot auto-apply", () => {
    expect(nameMatchConfidence(PHONETIC_MATCH_SIMILARITY, true, "user")).toBeLessThan(AUTO_APPLY_THRESHOLD);
    expect(nameMatchConfidence(PHONETIC_MATCH_SIMILARITY, true, "user")).toBe(88);
  });

  it("the weakest admissible pair (60/60) lands at 64, not 92", () => {
    expect(nameMatchConfidence(60, true, "user")).toBe(60 + ALIAS_AGREEMENT_BONUS);
    expect(shouldAutoApply(nameMatchConfidence(60, true, "user"))).toBe(false);
  });

  it("agreement still lifts literal evidence over the gate", () => {
    // name verbatim in the transaction text (95) + an alias: 86 + 4 = 90
    expect(nameMatchConfidence(95, true, "user")).toBe(90);
    expect(shouldAutoApply(90)).toBe(true);
    // without agreement the same evidence stays at 86 (unchanged behaviour)
    expect(nameMatchConfidence(95, false, "user")).toBe(86);
  });

  it("phonetic name + phonetic alias via matchTransaction stays below auto-apply", () => {
    const results = matchTransaction(
      tx({ partner: "Maier Bau" }),
      [pd({ id: "u1", name: "Meyer Bau", aliases: ["Mayer Bau"] })],
      []
    );
    expect(results[0].confidence).toBe(88);
    expect(shouldAutoApply(results[0].confidence)).toBe(false);
  });
});

describe("global presets are held to a stricter bar (fork #71 item 4)", () => {
  it("approximate name evidence caps a global partner below the gate, a user partner is unaffected", () => {
    // partner field "Amazon Europe" is a PREFIX of both names (neither appears
    // verbatim in the transaction text): name "Amazon Europe Core" → containment
    // 75 + 25·13/18 = 93, alias "Amazon Europe Core Ops" → 90; best 93 → 84.75 + 4 = 88.75
    const partner = { id: "p1", name: "Amazon Europe Core", aliases: ["Amazon Europe Core Ops"] };
    const t = tx({ partner: "Amazon Europe" });

    const asUser = matchTransaction(t, [pd(partner)], []);
    expect(asUser[0].confidence).toBe(89);
    expect(shouldAutoApply(asUser[0].confidence)).toBe(true);

    const asGlobal = matchTransaction(t, [], [pd(partner)]);
    expect(asGlobal[0].confidence).toBe(GLOBAL_APPROXIMATE_NAME_CAP);
    expect(shouldAutoApply(asGlobal[0].confidence)).toBe(false);
  });

  it("literal name evidence still auto-applies a global partner", () => {
    // "uber" appears verbatim in the transaction text (alias, 95) and the primary
    // name is a containment match (81) → 86 + 4 = 90
    const results = matchTransaction(tx({ partner: "Uber" }), [], [UBER]);
    expect(results[0]).toMatchObject({ partnerId: UBER.id, source: "name", confidence: 90 });
    expect(shouldAutoApply(results[0].confidence)).toBe(true);
  });

  it("IBAN, pattern and website matches on global partners are unchanged", () => {
    const iban = matchTransaction(
      tx({ partner: "Whatever", partnerIban: "AT611904300234573201" }),
      [],
      [pd({ id: "g1", name: "Zzz", ibans: ["AT61 1904 3002 3457 3201"] })]
    );
    expect(iban[0].confidence).toBe(100);

    const pattern = matchTransaction(
      tx({ name: "UBER *TRIP" }),
      [],
      [pd({ id: "g2", name: "Zzz", patterns: [{ pattern: "*uber*", confidence: 92 }] })]
    );
    expect(pattern[0].confidence).toBe(92);

    const website = matchTransaction(
      tx({ name: "Payment to uber.com" }),
      [],
      [pd({ id: "g3", name: "Zzz", website: "https://www.uber.com/" })]
    );
    expect(website[0].confidence).toBe(90);
  });
});

describe("the live incidents end to end", () => {
  it("esim.me no longer matches S IMMO AG at all", () => {
    const results = matchTransaction(
      tx({ name: "Card payment", partner: "esim.me" }),
      [],
      [S_IMMO]
    );
    expect(results).toEqual([]);
  });

  it("Uber ranks Uber Technologies first; Bayer AG and PORR AG are absent", () => {
    const results = matchTransaction(tx({ partner: "Uber" }), [], [BAYER, PORR, UBER]);
    expect(results.map((r) => r.partnerId)).toEqual([UBER.id]);
    expect(shouldAutoApply(results[0].confidence)).toBe(true);
  });
});
