/**
 * The pattern layer's provider-neutral output (#240).
 *
 * The layer keeps deciding *what* to look for out of a transaction and its
 * learned Partner data; what changed is that its decisions no longer leave in
 * Gmail's dialect. Every suggestion now carries `terms` beside its label, and
 * these tests pin that no Gmail operator survives inside one — an operator that
 * leaked through would reach an IMAP mailbox as a literal word.
 *
 * Pure functions, no Firestore and no Gemini: the Gemini path lowers its
 * answers through the same `suggestionTerms` covered here.
 */

import { describe, it, expect } from "vitest";
import {
  generateTypedSearchQueries,
  suggestionTerms,
  type QueryGenerationPartner,
  type QueryGenerationTransaction,
} from "../generateSearchQueries";
import type { MailSearchTerms } from "../../mail/provider";

/** Every string a search would actually be executed on. */
function termValues(terms: MailSearchTerms): string[] {
  return [
    ...(terms.keywords ?? []),
    ...(terms.filenames ?? []),
    ...(terms.from ? [terms.from] : []),
  ];
}

const TRANSACTION: QueryGenerationTransaction = {
  name: "NETFLIX.COM AMSTERDAM",
  partner: "Netflix",
  reference: "RE-2026-00812",
};

const PARTNER: QueryGenerationPartner = {
  name: "Netflix International B.V.",
  emailDomains: ["netflix.com"],
  website: "www.netflix.com",
};

describe("suggestionTerms", () => {
  it("reads from: off a generated email-domain suggestion", () => {
    expect(suggestionTerms("from:netflix.com", "email_domain")).toEqual({
      from: "netflix.com",
    });
  });

  it("treats a bare domain as a sender too, whoever wrote it", () => {
    // Gemini is prompted in Gmail's dialect but answers loosely; a domain as
    // free text finds little, and it means what the generator's from: means.
    expect(suggestionTerms("netflix.com", "email_domain")).toEqual({
      from: "netflix.com",
    });
  });

  it("leaves a company-name suggestion as plain keywords", () => {
    expect(suggestionTerms("netflix international", "company_name")).toEqual({
      keywords: ["netflix", "international"],
    });
  });

  it("lowers a learned mail pattern, operators and all", () => {
    expect(suggestionTerms("from:amazon.de rechnung", "pattern")).toEqual({
      keywords: ["rechnung"],
      from: "amazon.de",
    });
  });
});

describe("generateTypedSearchQueries", () => {
  it("gives every suggestion terms that carry no Gmail syntax", () => {
    const suggestions = generateTypedSearchQueries(TRANSACTION, PARTNER);

    expect(suggestions.length).toBeGreaterThan(0);
    for (const suggestion of suggestions) {
      expect(suggestion.terms).toBeDefined();
      expect(termValues(suggestion.terms).length).toBeGreaterThan(0);
      for (const value of termValues(suggestion.terms)) {
        expect(value).not.toContain(":");
      }
    }
  });

  it("keeps the label's own words, only out of the query dialect", () => {
    const suggestions = generateTypedSearchQueries(TRANSACTION, PARTNER);

    const domain = suggestions.find((s) => s.query === "from:netflix.com");
    expect(domain?.terms).toEqual({ from: "netflix.com" });

    // The invoice number is the highest-scored suggestion and has to stay a
    // searchable term, not decoration on a label. Its words are ANDed, which is
    // what the label meant when it was a Gmail query string.
    const invoice = suggestions.find((s) => s.type === "invoice_number");
    expect(invoice).toBeDefined();
    expect(invoice?.terms.keywords?.join(" ")).toBe(invoice?.query);
  });
});
