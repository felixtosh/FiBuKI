/**
 * Tests for identity matching (issue #232).
 *
 * The old name lane was a two-way substring on lowercased names. It missed the
 * three most ordinary ways a real invoice prints a real name: middle names,
 * punctuation, and word order. These tests pin the new behaviour and, just as
 * importantly, pin that everything the substring lane matched still matches.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeIdentityName,
  identityNameTokens,
  identityNameMatches,
  getAllIdentityNames,
  getAllIdentityVatIds,
  getAllIdentityIbans,
  matchEntityToIdentity,
  entityMatchesUserData,
  determineCounterparty,
  type UserIdentityData,
} from "./identity-matcher";

const entity = (over: Partial<Record<string, string | null>> = {}) => ({
  name: null,
  vatId: null,
  address: null,
  iban: null,
  website: null,
  ...over,
});

describe("normalizeIdentityName", () => {
  it("casefolds and collapses whitespace", () => {
    expect(normalizeIdentityName("  STEFAN   Herbert ")).toBe("stefan herbert");
  });

  it("expands German umlauts and eszett", () => {
    expect(normalizeIdentityName("Jörg Müller-Straß")).toBe("joerg mueller strass");
  });

  it("strips diacritics that decompose", () => {
    expect(normalizeIdentityName("José Ferrão")).toBe("jose ferrao");
  });

  it("treats decomposed input the same as composed input", () => {
    // "Müller" as u + U+0308 COMBINING DIAERESIS, the form OCR and PDF text
    // often arrive in.
    expect(normalizeIdentityName("Müller")).toBe("mueller");
    expect(identityNameMatches("Müller", "Müller")).toBe(true);
  });

  it("folds letters that do not decompose", () => {
    expect(normalizeIdentityName("Søren Ærø")).toBe("soeren aeroe");
  });

  it("folds typographic punctuation to ASCII", () => {
    // U+2018 LEFT SINGLE QUOTATION MARK, the codepoint from the live example
    expect(normalizeIdentityName("Stefan‘s Individual Org")).toBe(
      "stefan s individual org"
    );
    expect(normalizeIdentityName("Alpha–Beta")).toBe("alpha beta");
  });

  it("returns an empty string for empty input", () => {
    expect(normalizeIdentityName("")).toBe("");
    expect(normalizeIdentityName("   ")).toBe("");
  });
});

describe("identityNameTokens", () => {
  it("drops legal-form tokens so e.U. and eU agree", () => {
    expect(identityNameTokens("Yazzbert e.U.")).toEqual(["yazzbert"]);
    expect(identityNameTokens("Yazzbert eU")).toEqual(["yazzbert"]);
    expect(identityNameTokens("Yazzbert GmbH")).toEqual(["yazzbert"]);
  });

  it("drops single-character tokens left behind by punctuation", () => {
    expect(identityNameTokens("Stefan Y. Herbert")).toEqual(["stefan", "herbert"]);
    expect(identityNameTokens("Stefan‘s Org")).toEqual(["stefan", "org"]);
  });

  it("deduplicates repeated tokens", () => {
    expect(identityNameTokens("Herbert Herbert")).toEqual(["herbert"]);
  });

  it("returns an empty list when nothing survives", () => {
    expect(identityNameTokens("GmbH")).toEqual([]);
    expect(identityNameTokens("")).toEqual([]);
  });
});

describe("identityNameMatches", () => {
  it("matches across an inserted middle name", () => {
    expect(identityNameMatches("Stefan Herbert", "STEFAN YAZZIE HERBERT")).toBe(true);
  });

  it("matches across legal-form punctuation", () => {
    expect(identityNameMatches("Yazzbert e.U.", "Yazzbert eU")).toBe(true);
    expect(identityNameMatches("Yazzbert eU", "Yazzbert e.U.")).toBe(true);
  });

  it("matches regardless of word order", () => {
    expect(identityNameMatches("Stefan Herbert", "HERBERT Stefan")).toBe(true);
  });

  it("matches across a typographic apostrophe the user cannot see", () => {
    expect(
      identityNameMatches("Stefan's Individual Org", "Stefan‘s Individual Org")
    ).toBe(true);
  });

  it("matches across diacritic spelling variants", () => {
    expect(identityNameMatches("Jörg Müller", "Joerg Mueller")).toBe(true);
  });

  // Regression guard: everything the substring lane matched must still match.
  it("keeps matching the substring cases", () => {
    expect(identityNameMatches("Amazon", "Amazon EU S.a.r.l.")).toBe(true);
    expect(identityNameMatches("Stefan Herbert", "Stefan")).toBe(true);
    expect(identityNameMatches("Herbert", "Stefan Herbert Consulting")).toBe(true);
  });

  it("does not match unrelated names", () => {
    expect(identityNameMatches("Stefan Herbert", "Maria Gruber")).toBe(false);
    expect(identityNameMatches("Stefan Herbert", "Herbert Immobilien GmbH")).toBe(false);
  });

  it("never matches on an empty name", () => {
    expect(identityNameMatches("", "Stefan Herbert")).toBe(false);
    expect(identityNameMatches("Stefan Herbert", "")).toBe(false);
  });

  // An identity with no tokens left would otherwise be a subset of every
  // document entity, matching everything.
  it("never matches on the token lane when a name is legal-form only", () => {
    expect(identityNameMatches("GmbH", "Random Consulting AG")).toBe(false);
    expect(identityNameMatches("Stefan Herbert", "GmbH")).toBe(false);
  });
});

describe("identity accessors", () => {
  const userData: UserIdentityData = {
    personalEntity: {
      name: "Stefan Herbert",
      aliases: ["Stefan Yazzie Herbert"],
      vatId: "ATU12345678",
      ibans: ["AT61 1904 3002 3457 3201"],
    },
    companies: [
      { name: "Yazzbert e.U.", aliases: ["Yazzbert"], vatId: "ATU87654321", ibans: [] },
    ],
    name: "Stefan Herbert",
    companyName: "Yazzbert e.U.",
    aliases: ["Herbert Stefan"],
    vatIds: ["ATU12345678"],
    ibans: [],
  };

  it("collects names from new format, companies and legacy fields without duplicates", () => {
    expect(getAllIdentityNames(userData)).toEqual([
      "Stefan Herbert",
      "Stefan Yazzie Herbert",
      "Yazzbert e.U.",
      "Yazzbert",
      "Herbert Stefan",
    ]);
  });

  it("collects VAT IDs without duplicates", () => {
    expect(getAllIdentityVatIds(userData)).toEqual(["ATU12345678", "ATU87654321"]);
  });

  it("collects IBANs", () => {
    expect(getAllIdentityIbans(userData)).toEqual(["AT61 1904 3002 3457 3201"]);
  });

  it("tolerates an empty user data object", () => {
    expect(getAllIdentityNames({})).toEqual([]);
    expect(getAllIdentityVatIds({})).toEqual([]);
    expect(getAllIdentityIbans({})).toEqual([]);
  });
});

describe("matchEntityToIdentity", () => {
  const userData: UserIdentityData = {
    personalEntity: {
      name: "Stefan Herbert",
      aliases: [],
      vatId: "ATU12345678",
      ibans: ["AT611904300234573201"],
    },
  };

  it("reports the VAT lane first, ignoring formatting", () => {
    const match = matchEntityToIdentity(entity({ vatId: "atu 1234 5678" }), userData, []);
    expect(match).toEqual({
      lane: "vatId",
      entityValue: "atu 1234 5678",
      identityValue: "ATU12345678",
    });
  });

  it("reports the IBAN lane for identity IBANs", () => {
    expect(
      matchEntityToIdentity(entity({ iban: "at61 1904 3002 3457 3201" }), userData, [])?.lane
    ).toBe("iban");
  });

  it("reports the source-IBAN lane for connected bank accounts", () => {
    expect(
      matchEntityToIdentity(entity({ iban: "AT483200000012345864" }), userData, [
        "AT483200000012345864",
      ])?.lane
    ).toBe("sourceIban");
  });

  it("reports the name lane for a token-subset match", () => {
    expect(
      matchEntityToIdentity(entity({ name: "STEFAN YAZZIE HERBERT" }), userData, [])
    ).toEqual({
      lane: "name",
      entityValue: "STEFAN YAZZIE HERBERT",
      identityValue: "Stefan Herbert",
    });
  });

  it("returns null for a null entity and for no match", () => {
    expect(matchEntityToIdentity(null, userData, [])).toBeNull();
    expect(matchEntityToIdentity(entity({ name: "Maria Gruber" }), userData, [])).toBeNull();
  });

  it("entityMatchesUserData is the boolean form", () => {
    expect(entityMatchesUserData(entity({ name: "HERBERT Stefan" }), userData, [])).toBe(true);
    expect(entityMatchesUserData(entity({ name: "Maria Gruber" }), userData, [])).toBe(false);
  });
});

describe("determineCounterparty", () => {
  const userData: UserIdentityData = {
    personalEntity: { name: "Stefan Herbert", aliases: [], ibans: [] },
  };
  const issuer = entity({ name: "Amazon EU S.a.r.l." });
  const recipient = entity({ name: "STEFAN YAZZIE HERBERT" });

  it("is incoming when the recipient is the user", () => {
    expect(determineCounterparty(issuer, recipient, userData, [])).toEqual({
      counterparty: issuer,
      matchedUserAccount: "recipient",
      invoiceDirection: "incoming",
      recipientIdentityMatch: "user",
    });
  });

  it("is outgoing when the issuer is the user", () => {
    expect(determineCounterparty(recipient, issuer, userData, [])).toEqual({
      counterparty: issuer,
      matchedUserAccount: "issuer",
      invoiceDirection: "outgoing",
      // The recipient of a document the user issued is a client, and saying so
      // is the true fact; whether it is a § 12 finding is the classifier's call.
      recipientIdentityMatch: "third-party",
    });
  });

  it("is unknown when neither side matches", () => {
    const other = entity({ name: "Maria Gruber" });
    expect(determineCounterparty(issuer, other, userData, [])).toEqual({
      counterparty: issuer,
      matchedUserAccount: null,
      invoiceDirection: "unknown",
      recipientIdentityMatch: "third-party",
    });
  });

  // Both matching is a self-invoice or internal transfer: existing behaviour
  // treats it as outgoing with the recipient as counterparty.
  it("is outgoing when both sides match", () => {
    expect(determineCounterparty(recipient, recipient, userData, [])).toEqual({
      counterparty: recipient,
      matchedUserAccount: "issuer",
      invoiceDirection: "outgoing",
      recipientIdentityMatch: "user",
    });
  });

  it("is unknown when there is no user data at all", () => {
    expect(determineCounterparty(issuer, recipient, null, [])).toEqual({
      counterparty: issuer,
      matchedUserAccount: null,
      invoiceDirection: "unknown",
      recipientIdentityMatch: "unknown",
    });
  });
});

// #229: the verdict rides on the same comparison, so widening the name lane
// widens it too. A recipient that only a token-set match can resolve now
// reads "user" where the substring lane left it "third-party".
describe("determineCounterparty recipient identity verdict", () => {
  const userData: UserIdentityData = {
    personalEntity: { name: "Stefan Herbert", aliases: [], ibans: [] },
  };
  const issuer = entity({ name: "Amazon EU S.a.r.l." });

  it("is user when only the token lane resolves the recipient", () => {
    const recipient = entity({ name: "HERBERT Stefan" });
    expect(determineCounterparty(issuer, recipient, userData, []).recipientIdentityMatch).toBe(
      "user"
    );
  });

  it("is unknown when the document names no recipient", () => {
    expect(determineCounterparty(issuer, null, userData, []).recipientIdentityMatch).toBe(
      "unknown"
    );
  });

  it("is unknown when the user has configured no identity at all", () => {
    const recipient = entity({ name: "Maria Gruber" });
    expect(determineCounterparty(issuer, recipient, {}, []).recipientIdentityMatch).toBe("unknown");
  });

  it("is user when a connected bank account IBAN identifies the recipient", () => {
    const recipient = entity({ iban: "AT48 3200 0000 1234 5864" });
    expect(
      determineCounterparty(issuer, recipient, {}, ["AT483200000012345864"])
        .recipientIdentityMatch
    ).toBe("user");
  });
});
