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

  it("strips Gmail's grouping, which turns an OR query into an AND one", () => {
    // Recorded rather than hidden: the parens and the bare OR are dropped and
    // both words become ordinary keywords, which buildGmailQuery then ANDs. So
    // this query NARROWS — a mail carrying only "rechnung" was returned before
    // and is not returned now. Named keywords have to AND (see the AND test
    // below), and nothing in the vocabulary says "any of these", so the two
    // cannot both be had until that is decided. See #240.
    expect(termsFromQuery("(rechnung OR invoice)")).toEqual({
      keywords: ["rechnung", "invoice"],
    });
    expect(buildGmailQuery(termsFromQuery("(rechnung OR invoice)"))).toBe(
      "rechnung invoice has:attachment"
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
