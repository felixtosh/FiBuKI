/**
 * The provider-neutral search vocabulary (#240), read and written.
 *
 * `termsFromQuery` undoes Gmail's dialect (the manual attach path is full of
 * strings that were written as Gmail queries); `buildGmailQuery` writes it back
 * for the one mailbox that speaks it. The two are pinned together here because
 * the failure mode is silent: a term that survives one direction and not the
 * other searches for something the user never asked for.
 *
 * Neither module touches the network, so no mocks are needed.
 */

import { describe, it, expect } from "vitest";
import { termsFromQuery } from "../search-terms";
import { buildGmailQuery } from "../gmail-query";
import { INVOICE_KEYWORDS } from "../constants";

// ---- reading a written query ------------------------------------------------

describe("termsFromQuery", () => {
  it("lowers a learned Partner pattern to a sender plus keywords", () => {
    expect(termsFromQuery("from:amazon.de rechnung")).toEqual({
      keywords: ["rechnung"],
      from: "amazon.de",
    });
  });

  it("keeps plain words as keywords and carries no operator through", () => {
    const terms = termsFromQuery("netflix rechnung");
    expect(terms).toEqual({ keywords: ["netflix", "rechnung"] });
    // Nothing a provider would have to parse survives in a term's value.
    expect(terms.keywords?.some((k) => k.includes(":"))).toBe(false);
  });

  it("reads filename: and has:attachment, and drops a Gmail-only has: value", () => {
    expect(termsFromQuery("filename:RE-2024-88 has:attachment")).toEqual({
      filenames: ["RE-2024-88"],
      hasAttachment: true,
    });
    expect(termsFromQuery("has:userlabels")).toEqual({});
  });

  it("lowers subject: to a keyword rather than losing the word", () => {
    // No neutral term says "in the subject only"; dropping it would lose the
    // search, so the word survives as free text.
    expect(termsFromQuery('subject:"Ihre Rechnung"')).toEqual({
      keywords: ["Ihre Rechnung"],
    });
  });

  it("reads an OR between words as one any-of group (#274)", () => {
    // "(rechnung OR invoice)" means either word. Lowered to plain keywords it
    // would AND and miss every mail carrying only one of them.
    expect(termsFromQuery("(rechnung OR invoice)")).toEqual({
      anyOf: [["rechnung", "invoice"]],
    });
    expect(buildGmailQuery(termsFromQuery("(rechnung OR invoice)"))).toBe(
      "(rechnung OR invoice) has:attachment"
    );
  });

  it("keeps juxtaposed words ANDed beside an any-of group", () => {
    expect(termsFromQuery("amazon (rechnung OR invoice OR beleg)")).toEqual({
      keywords: ["amazon"],
      anyOf: [["rechnung", "invoice", "beleg"]],
    });
    expect(buildGmailQuery(termsFromQuery("amazon (rechnung OR invoice)"))).toBe(
      "amazon (rechnung OR invoice) has:attachment"
    );
  });

  it("reads two OR groups as two separate groups", () => {
    expect(termsFromQuery("(a OR b) (c OR d)")).toEqual({ anyOf: [["a", "b"], ["c", "d"]] });
  });

  it("keeps a quoted phrase whole inside a group", () => {
    expect(termsFromQuery('"Ihre Rechnung" OR invoice')).toEqual({
      anyOf: [["Ihre Rechnung", "invoice"]],
    });
    expect(buildGmailQuery(termsFromQuery('"Ihre Rechnung" OR invoice'))).toBe(
      '("Ihre Rechnung" OR invoice) has:attachment'
    );
  });

  it("ignores an OR with no word on one side", () => {
    expect(termsFromQuery("OR rechnung")).toEqual({ keywords: ["rechnung"] });
    expect(termsFromQuery("rechnung OR")).toEqual({ keywords: ["rechnung"] });
    expect(termsFromQuery("from:amazon.de OR rechnung")).toEqual({
      from: "amazon.de",
      keywords: ["rechnung"],
    });
  });

  it("an any-of group alone opts out of the invoice sweep", () => {
    // Naming a group is naming a term: the shared keyword list must not be
    // ORed in beside it.
    expect(buildGmailQuery({ anyOf: [["rechnung", "invoice"]] })).toBe(
      "(rechnung OR invoice) has:attachment"
    );
  });

  it("drops a Gmail-only operator instead of smuggling it through as a keyword", () => {
    // #240's first acceptance criterion: the request carries no provider
    // syntax. Held as free text these are re-emitted unquoted, so Gmail reads
    // them back as the operators they always were and IMAP searches for the
    // literal string. Dropping only widens the search.
    expect(termsFromQuery("label:Rechnungen invoice")).toEqual({ keywords: ["invoice"] });
    expect(termsFromQuery("is:unread rechnung")).toEqual({ keywords: ["rechnung"] });
    expect(termsFromQuery("after:2024/01/01 rechnung")).toEqual({ keywords: ["rechnung"] });
    expect(termsFromQuery("to:me@example.at rechnung")).toEqual({ keywords: ["rechnung"] });
    expect(termsFromQuery("newer_than:7d beleg")).toEqual({ keywords: ["beleg"] });
    expect(termsFromQuery("older_than:1y beleg")).toEqual({ keywords: ["beleg"] });
  });

  it("keeps a colon that is part of an ordinary search term", () => {
    // An invoice number is text, not an operator, and Gmail reads it as text
    // too. This is why the operators are listed rather than matched by shape.
    expect(termsFromQuery("RE:2024-88")).toEqual({ keywords: ["RE:2024-88"] });
  });

  it("drops a negated term rather than searching for a literal dash-word", () => {
    // Nothing in the vocabulary says "not". Dropping widens the search; keeping
    // "-werbung" as a keyword would find nothing at all.
    expect(termsFromQuery("rechnung -werbung")).toEqual({ keywords: ["rechnung"] });
  });

  it("returns nothing for an empty query", () => {
    expect(termsFromQuery("   ")).toEqual({});
  });
});

// ---- writing Gmail's dialect back -------------------------------------------

describe("buildGmailQuery", () => {
  it("spells the invoice sweep exactly as the sync worker always has", () => {
    // Terms that name nothing at all = the query GmailProvider sent before the
    // vocabulary existed. Byte-identical, because Sync's recall rides on it.
    const expected = `(${INVOICE_KEYWORDS.map((k) => `"${k}"`).join(" OR ")}) has:attachment filename:pdf`;
    expect(buildGmailQuery({})).toBe(expected);
  });

  it("ANDs named keywords instead of ORing them", () => {
    // "netflix rechnung" means both words, which is what Gmail's juxtaposition
    // has always done for it. An OR here would widen every two-word suggestion
    // into "any invoice, or anything from Netflix".
    expect(buildGmailQuery({ keywords: ["netflix", "rechnung"] })).toBe(
      "netflix rechnung has:attachment"
    );
  });

  it("quotes only a keyword that carries whitespace", () => {
    // Quoting a single word turns a token match into a phrase match and would
    // narrow what the attach path finds today.
    expect(buildGmailQuery({ keywords: ["Ihre Rechnung", "netflix"] })).toBe(
      '"Ihre Rechnung" netflix has:attachment'
    );
  });

  it("writes the sender and ORs filename alternatives", () => {
    expect(
      buildGmailQuery({ keywords: [], from: "amazon.de", filenames: ["pdf", "RE-88"] })
    ).toBe("from:amazon.de has:attachment (filename:pdf OR filename:RE-88)");
  });

  it("drops has:attachment only when the caller says so", () => {
    expect(buildGmailQuery({ keywords: ["rechnung"], hasAttachment: false })).toBe(
      "rechnung"
    );
  });

  it("keeps a named-but-empty term list out of the invoice sweep", () => {
    // The attach path's "no keywords" is not Sync's "no keywords": naming an
    // empty list must not summon the shared keyword clause.
    expect(buildGmailQuery({ keywords: [], filenames: [] })).toBe("has:attachment");
  });
});

// ---- the round trip ---------------------------------------------------------

describe("a written query survives the round trip", () => {
  it("compiles back to the same terms Gmail was asked for", () => {
    const written = "from:amazon.de rechnung";
    const terms = termsFromQuery(written);
    // What Gmail receives now vs. the string the attach path used to send: same
    // clauses, reordered, plus the attachment constraint it always appended.
    expect(buildGmailQuery(terms)).toBe("rechnung from:amazon.de has:attachment");
    expect(termsFromQuery(buildGmailQuery(terms))).toEqual({
      ...terms,
      hasAttachment: true,
    });
  });
});
