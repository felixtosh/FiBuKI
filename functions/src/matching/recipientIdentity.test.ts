/**
 * The recipient-identity verdict (#229).
 *
 * Every case here is really the same question asked twice: does a failed
 * comparison mean "somebody else" or "we could not tell"? Getting that wrong
 * in the safe direction misses a catch; getting it wrong in the other
 * direction blocks a legitimate Vorsteuer deduction on every document in the
 * corpus at once.
 */

import { describe, it, expect } from "vitest";
import {
  hasIdentitySignals,
  hasRecipientEntity,
  resolveRecipientIdentity,
} from "./recipientIdentity";

describe("hasIdentitySignals", () => {
  it("reads an empty settings document as no identity at all", () => {
    expect(hasIdentitySignals({})).toBe(false);
    expect(hasIdentitySignals({ names: [""], vatIds: [], ibans: [null] })).toBe(false);
    expect(hasIdentitySignals({ names: ["   "] })).toBe(false);
  });

  it("counts any one configured signal, including a connected account's IBAN", () => {
    expect(hasIdentitySignals({ names: ["Yazzbert e.U."] })).toBe(true);
    expect(hasIdentitySignals({ vatIds: ["ATU78971436"] })).toBe(true);
    expect(hasIdentitySignals({ sourceIbans: ["AT611904300234573201"] })).toBe(true);
  });
});

describe("hasRecipientEntity", () => {
  it("treats an absent or empty recipient block as nothing to judge", () => {
    expect(hasRecipientEntity(null)).toBe(false);
    expect(hasRecipientEntity(undefined)).toBe(false);
    expect(hasRecipientEntity({})).toBe(false);
    expect(hasRecipientEntity({ name: "", vatId: null })).toBe(false);
  });

  it("reads a recipient off any of the three identifying fields", () => {
    expect(hasRecipientEntity({ name: "Maria Musterfrau" })).toBe(true);
    expect(hasRecipientEntity({ vatId: "ATU12345678" })).toBe(true);
    expect(hasRecipientEntity({ iban: "AT611904300234573201" })).toBe(true);
  });
});

describe("resolveRecipientIdentity", () => {
  it("says third-party only when a real comparison actually failed", () => {
    expect(
      resolveRecipientIdentity({
        recipientPresent: true,
        recipientMatchesUser: false,
        hasIdentityData: true,
      })
    ).toBe("third-party");
  });

  it("says user when the comparison succeeded", () => {
    expect(
      resolveRecipientIdentity({
        recipientPresent: true,
        recipientMatchesUser: true,
        hasIdentityData: true,
      })
    ).toBe("user");
  });

  it("refuses to guess when the user has configured no identity", () => {
    // Otherwise every document in the corpus becomes third-party at once, and
    // the rule blocks every deduction the user has.
    expect(
      resolveRecipientIdentity({
        recipientPresent: true,
        recipientMatchesUser: false,
        hasIdentityData: false,
      })
    ).toBe("unknown");
  });

  it("refuses to guess when the document names no recipient", () => {
    // A Kleinbetragsrechnung prints none by law, and an extraction that read
    // none says nothing about who the supply was rendered to.
    expect(
      resolveRecipientIdentity({
        recipientPresent: false,
        recipientMatchesUser: false,
        hasIdentityData: true,
      })
    ).toBe("unknown");
  });
});
