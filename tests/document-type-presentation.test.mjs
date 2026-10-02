import test from "node:test";
import assert from "node:assert/strict";
import {
  describeInvoiceDirection,
  describeDirectionReview,
  describeForeignRecipient,
  describeRepairAmbiguity,
  describeDocumentType,
  describeDocumentationState,
  describeDocumentTypeBasis,
  describeMissingElements,
  describeSection11Element,
  buildSupplierRequestText,
  describeSection11Consequence,
  describeTerm,
  TERM_GLOSSES,
  DOCUMENT_TYPES,
  DOCUMENTATION_STATES,
} from "../lib/documents/document-type-presentation.js";

function basis(overrides = {}) {
  return {
    reason: "section-11-satisfied",
    regime: "standard",
    grossTotal: 120_00,
    selfDesignation: null,
    selfDesignationClass: null,
    zeroVatReason: null,
    degraded: false,
    ...overrides,
  };
}

test("describeDocumentType: an absent type reads as not-established, never as missing data", () => {
  for (const value of [undefined, null, "unknown"]) {
    const presentation = describeDocumentType(value);
    assert.equal(presentation.type, "unknown");
    assert.equal(presentation.label, "Not determined");
    assert.equal(presentation.labelKey, "documents.type.unknown");
    assert.equal(presentation.tone, "unset");
    assert.ok(presentation.summary.length > 0);
    assert.ok(!presentation.summary.toLowerCase().includes("error"));
  }
});

test("describeDocumentType: an unrecognised value degrades to unknown rather than blank", () => {
  const presentation = describeDocumentType("gutschrift");
  assert.equal(presentation.type, "unknown");
  assert.equal(presentation.label, "Not determined");
});

test("describeDocumentType: the four types each render with their own label and tone", () => {
  assert.deepEqual(
    ["invoice", "receipt", "other", "unknown"].map((t) => {
      const p = describeDocumentType(t);
      // The KEY is the contract: the word follows the interface locale through
      // messages/{en,de}.json, and `label` is only the English fallback for
      // callers with no translator (the agent tools, the exports, this test).
      return [p.labelKey, p.label, p.tone];
    }),
    [
      ["documents.type.invoice", "Invoice", "positive"],
      ["documents.type.receipt", "Payment confirmation", "warning"],
      ["documents.type.other", "Not a document", "neutral"],
      ["documents.type.unknown", "Not determined", "unset"],
    ],
  );
});

test("a corpus where most files are unknown renders every row", () => {
  // The shape the backfill leaves behind: a long tail of files carrying no
  // verdict at all, a few classified.
  const corpus = Array.from({ length: 40 }, (_, i) => {
    if (i === 7) return { documentType: "invoice" };
    if (i === 19) return { documentType: "receipt" };
    if (i === 23) return { documentType: "unknown" };
    return {};
  });

  const rendered = corpus.map((file) => describeDocumentType(file.documentType));

  assert.equal(rendered.filter((r) => r.type === "unknown").length, 38);
  assert.ok(rendered.every((r) => r.label.trim().length > 0));
  assert.ok(rendered.every((r) => r.tone !== "warning" || r.type === "receipt"));
});

test("describeSection11Element: elements read in English, with the German and the statute kept (#237)", () => {
  // ADR-0007: the element names translate in the English UI. The German is
  // kept for the supplier mail and for the bracket on first use; the citation
  // is an audit reference behind the click.
  assert.deepEqual(describeSection11Element("invoice-number"), {
    element: "invoice-number",
    label: "Sequential invoice number",
    labelKey: "documents.element.invoiceNumber",
    german: "Fortlaufende Nummer",
    citation: "§ 11 Abs 1 lit. h",
  });
  assert.deepEqual(describeSection11Element("supplier-vat-id"), {
    element: "supplier-vat-id",
    label: "Supplier VAT ID",
    labelKey: "documents.element.supplierVatId",
    german: "UID-Nummer des liefernden Unternehmers",
    citation: "§ 11 Abs 1 lit. i",
  });
});

test("every § 11 element has an English label distinct from its German name", () => {
  for (const element of [
    "issue-date",
    "supplier-name",
    "supplier-address",
    "description",
    "steuersatz",
    "invoice-number",
    "supplier-vat-id",
    "recipient",
    "recipient-vat-id",
  ]) {
    const described = describeSection11Element(element);
    assert.ok(described.label.length > 0, element);
    assert.ok(described.german.length > 0, element);
    assert.notEqual(described.label, described.german, element);
  }
});

test("describeSection11Element: an element this module cannot name still appears", () => {
  const described = describeSection11Element("delivery-period");
  assert.equal(described.label, "delivery-period");
  assert.equal(described.citation, "§ 11 UStG");
});

test("describeMissingElements: on a receipt the list is a defect to chase", () => {
  const missing = describeMissingElements("receipt", ["supplier-vat-id", "steuersatz"]);
  assert.equal(missing.isDefect, true);
  assert.equal(missing.tone, "warning");
  assert.equal(missing.heading, "Missing under § 11");
  assert.ok(missing.requestText);
  assert.match(missing.note, /supplier/i);
});

test("describeMissingElements: elements come back in statute order, deduplicated", () => {
  const missing = describeMissingElements("receipt", [
    "supplier-vat-id",
    "issue-date",
    "invoice-number",
    "issue-date",
  ]);
  assert.deepEqual(
    missing.items.map((i) => i.element),
    ["issue-date", "invoice-number", "supplier-vat-id"],
  );
});

test("a reverse-charge invoice reads as an invoice, not as a defective one", () => {
  // What the classifier stores for one: an invoice, no Austrian Steuersatz,
  // the reason stated on the document, and the sequential number not printed.
  const type = "invoice";
  const missing = describeMissingElements(type, ["invoice-number"]);

  assert.equal(describeDocumentType(type).tone, "positive");
  assert.equal(missing.isDefect, false);
  // #237: listing what a correct invoice lawfully leaves out argues with it,
  // so an invoice lists nothing at all.
  assert.deepEqual(missing.items, []);
  // Asking a reverse-charge supplier for a corrected invoice would be wrong.
  assert.equal(missing.requestText, null);

  const lines = describeDocumentTypeBasis(
    basis({ reason: "zero-vat-with-stated-regime", zeroVatReason: "reverse-charge" }),
    type,
  );
  const zeroVat = lines.find((l) => l.id === "zero-vat");
  assert.ok(zeroVat);
  assert.match(zeroVat.text, /Reverse charge/);
  assert.match(lines[0].text, /not a defective one/);
});

test("buildSupplierRequestText: names the elements a mail has to name", () => {
  const text = buildSupplierRequestText(["invoice-number", "supplier-vat-id"]);
  assert.match(text, /§ 11 UStG/);
  // German because its reader is an Austrian supplier, whatever the UI reads.
  assert.match(text, /- Fortlaufende Nummer \(§ 11 Abs 1 lit\. h\)/);
  assert.match(text, /- UID-Nummer des liefernden Unternehmers \(§ 11 Abs 1 lit\. i\)/);
  assert.equal(buildSupplierRequestText([]), null);
  assert.equal(buildSupplierRequestText(undefined), null);
});

test("describeDocumentTypeBasis: a printed Rechnung heading overruled by the structure says so", () => {
  const lines = describeDocumentTypeBasis(
    basis({
      reason: "missing-decisive-elements",
      selfDesignation: "Rechnung",
      selfDesignationClass: "invoice",
    }),
    "receipt",
  );
  const heading = lines.find((l) => l.id === "heading");
  assert.ok(heading);
  assert.match(heading.text, /»Rechnung«/);
  assert.match(heading.text, /read and overruled by the document's structure/);
});

test("describeDocumentTypeBasis: a receipt heading overruled the other way says so too", () => {
  const lines = describeDocumentTypeBasis(
    basis({ selfDesignation: "Quittung", selfDesignationClass: "receipt" }),
    "invoice",
  );
  const heading = lines.find((l) => l.id === "heading");
  assert.match(heading.text, /read and overruled by the document's structure/);
  assert.match(heading.text, /satisfies § 11/);
});

test("describeDocumentTypeBasis: a heading the structure agrees with is stated as evidence", () => {
  const lines = describeDocumentTypeBasis(
    basis({ selfDesignation: "Invoice", selfDesignationClass: "invoice" }),
    "invoice",
  );
  const heading = lines.find((l) => l.id === "heading");
  assert.match(heading.text, /the § 11 test agrees/);
  assert.doesNotMatch(heading.text, /overruled/);
});

test("describeDocumentTypeBasis: the regime names the threshold that picked it", () => {
  const kleinbetrag = describeDocumentTypeBasis(
    basis({ regime: "kleinbetrag", grossTotal: 3_500 }),
    "invoice",
  ).find((l) => l.id === "regime");
  assert.match(kleinbetrag.text, /Kleinbetragsrechnung/);
  assert.match(kleinbetrag.text, /Abs 6/);
  assert.match(kleinbetrag.text, /This document's total/);

  const standard = describeDocumentTypeBasis(
    basis({ regime: "standard", grossTotal: null }),
    "invoice",
  ).find((l) => l.id === "regime");
  assert.match(standard.text, /Abs 1/);
  assert.doesNotMatch(standard.text, /This document's total/);
});

test("describeDocumentTypeBasis: a degraded record explains itself instead of blaming the document", () => {
  const lines = describeDocumentTypeBasis(
    basis({ reason: "legacy-record-undecidable", degraded: true }),
    "unknown",
  );
  const degraded = lines.find((l) => l.id === "degraded");
  assert.ok(degraded);
  assert.match(degraded.text, /next time the file is extracted/);
  assert.match(degraded.text, /not a defect/);
});

test("describeDocumentTypeBasis: an unclassified file says so rather than rendering empty", () => {
  for (const value of [undefined, null]) {
    const lines = describeDocumentTypeBasis(value, undefined);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].id, "verdict");
    assert.match(lines[0].text, /Not classified yet/);
  }
});

test("describeDocumentTypeBasis: a reason this module has no wording for still renders a line", () => {
  const lines = describeDocumentTypeBasis(basis({ reason: "some-future-reason" }), "invoice");
  assert.equal(lines[0].id, "verdict");
  assert.ok(lines[0].text.length > 0);
});

test("describeMissingElements: nothing missing yields an empty list the caller can skip", () => {
  const missing = describeMissingElements("invoice", []);
  assert.deepEqual(missing.items, []);
  assert.equal(missing.requestText, null);
});

test("describeDocumentationState: an absent state reads as not-established, never as undocumented", () => {
  // A row written before #104 carries no state. Reading that as
  // `undocumented` would tell the operator a documented line has no document.
  for (const value of [undefined, null, "unknown"]) {
    const presentation = describeDocumentationState(value);
    assert.equal(presentation.state, "unknown");
    assert.equal(presentation.label, "Not determined");
    assert.equal(presentation.labelKey, "documents.type.unknown");
    assert.equal(presentation.tone, "unset");
  }
});

test("describeDocumentationState: an unrecognised value degrades to unknown rather than blank", () => {
  assert.equal(describeDocumentationState("receipt").state, "unknown");
});

test("describeDocumentationState: the five states each render with their own label and tone", () => {
  assert.deepEqual(
    [
      "invoice",
      "receipt-only",
      "no-receipt-category",
      "undocumented",
      "unknown",
    ].map((state) => {
      const p = describeDocumentationState(state);
      return [p.labelKey, p.label, p.tone];
    }),
    [
      ["documents.type.invoice", "Invoice", "positive"],
      ["documents.state.receiptOnly", "Payment confirmation only", "warning"],
      ["documents.state.noReceiptCategory", "Category instead of a document", "neutral"],
      ["documents.state.undocumented", "No document", "unset"],
      ["documents.type.unknown", "Not determined", "unset"],
    ],
  );
});

test("describeDocumentationState: a receipt-only line is visibly distinct from an invoiced one", () => {
  const receiptOnly = describeDocumentationState("receipt-only");
  const invoiced = describeDocumentationState("invoice");
  assert.notEqual(receiptOnly.label, invoiced.label);
  assert.notEqual(receiptOnly.tone, invoiced.tone);
  assert.match(receiptOnly.summary, /Vorsteuer/);
});

test("describeDocumentationState: a no-receipt category is distinguishable from a real invoice", () => {
  const category = describeDocumentationState("no-receipt-category");
  const invoiced = describeDocumentationState("invoice");
  assert.notEqual(category.label, invoiced.label);
  assert.notEqual(category.tone, invoiced.tone);
});

test("describeDocumentationState: an invoiced transaction reads in the document type's own words", () => {
  // The transaction and the file behind it must not read as two things.
  assert.equal(
    describeDocumentationState("invoice").label,
    describeDocumentType("invoice").label,
  );
});

test("describeInvoiceDirection: an unplaced document is unsigned, not income (#233)", () => {
  for (const value of [undefined, null, "unknown", "sideways"]) {
    const presentation = describeInvoiceDirection(value);
    assert.equal(presentation.direction, "unknown");
    assert.equal(presentation.sign, "unsigned");
    assert.equal(presentation.tone, "unset");
  }

  assert.equal(describeInvoiceDirection("incoming").sign, "negative");
  assert.equal(describeInvoiceDirection("outgoing").sign, "positive");
});

test("describeDirectionReview: nothing to show for a file that is not flagged", () => {
  assert.equal(describeDirectionReview(null), null);
  assert.equal(describeDirectionReview({}), null);
  assert.equal(describeDirectionReview({ needsDirectionReview: false }), null);
});

test("describeDirectionReview: a conflict reads as a finding and names what the money says", () => {
  const review = describeDirectionReview({
    needsDirectionReview: true,
    directionReviewReason: "conflict",
    directionSuggested: "incoming",
  });

  assert.equal(review.reason, "conflict");
  assert.equal(review.tone, "warning");
  assert.equal(review.suggestedDirection, "incoming");
  assert.match(review.suggestion, /this is a purchase/);
});

test("describeDirectionReview: an unestablished direction is not a finding against the document", () => {
  const review = describeDirectionReview({
    needsDirectionReview: true,
    directionReviewReason: "unknown-direction",
    directionSuggested: null,
  });

  assert.equal(review.tone, "unset");
  assert.equal(review.suggestion, null);
});

test("describeForeignRecipient: only speaks when the document is somebody else's (#229)", () => {
  assert.equal(describeForeignRecipient(false), null);
  assert.equal(describeForeignRecipient(undefined), null);

  const chip = describeForeignRecipient(true);
  assert.equal(chip.tone, "warning");
  assert.match(chip.text, /§ 12/);
});

test("describeRepairAmbiguity: nothing to show for a file whose transcription was not guessed at", () => {
  assert.equal(describeRepairAmbiguity(null), null);
  assert.equal(describeRepairAmbiguity({}), null);
  assert.equal(describeRepairAmbiguity({ needsRepairReview: false }), null);
  // The field list alone is not the flag — the detector writes both.
  assert.equal(describeRepairAmbiguity({ repairAmbiguousFields: ["address"] }), null);
});

test("describeRepairAmbiguity: a flagged file names the fields to check (#275)", () => {
  const chip = describeRepairAmbiguity({
    needsRepairReview: true,
    repairAmbiguousFields: ["address", "invoiceNumber"],
  });

  assert.equal(chip.tone, "warning");
  assert.deepEqual(chip.fields, ["address", "invoiceNumber"]);
  assert.match(chip.text, /Address and Invoice number/);
  // It has to say what was ambiguous, or the reader cannot judge the value.
  assert.match(chip.text, /b, f, n, r or t/);
});

test("describeRepairAmbiguity: names fields by the panel's labels, not response keys (#301)", () => {
  const chip = describeRepairAmbiguity({
    needsRepairReview: true,
    repairAmbiguousFields: ["date", "date_raw", "vatId", "rawText"],
  });

  // The keys stay what the parse produced; only the text is translated.
  assert.deepEqual(chip.fields, ["date", "date_raw", "vatId", "rawText"]);
  // Two keys that land on one row are named once.
  assert.match(chip.text, /in Document Date, VAT ID and Extracted text:/);
  assert.doesNotMatch(chip.text, /date_raw|vatId|rawText/);
});

test("describeRepairAmbiguity: still speaks when the field names are missing", () => {
  // A record flagged without names is worse read as "nothing happened".
  const chip = describeRepairAmbiguity({ needsRepairReview: true });

  assert.deepEqual(chip.fields, []);
  assert.ok(chip.text.length > 0);
  assert.ok(!chip.text.includes("undefined"));
});

test("describeDocumentTypeBasis: a third-party recipient is stated even when it is not the verdict", () => {
  const lines = describeDocumentTypeBasis(
    basis({ reason: "receipt-designation", recipientIdentity: "third-party" }),
    "receipt",
  );

  assert.ok(lines.some((line) => line.id === "recipient"));
});

test("describeDocumentTypeBasis: says nothing about a recipient it could not place", () => {
  const lines = describeDocumentTypeBasis(basis({ recipientIdentity: "unknown" }), "invoice");

  assert.equal(lines.some((line) => line.id === "recipient"), false);
});

test("describeMissingElements: an unknown File lists no elements and offers no mail (#237)", () => {
  // Reporting elements missing from a document we have not classified states
  // a defect we cannot stand behind.
  for (const type of ["unknown", undefined, null, "other"]) {
    const missing = describeMissingElements(type, ["supplier-vat-id", "steuersatz"]);
    assert.deepEqual(missing.items, [], String(type));
    assert.equal(missing.requestText, null, String(type));
    assert.equal(missing.isDefect, false, String(type));
  }
});

test("describeSection11Consequence: leads with the answer, then the reason, in one sentence (#237)", () => {
  const invoice = describeSection11Consequence("invoice", basis());
  assert.match(invoice, /^Input VAT \(Vorsteuer\) is deductible, because /);

  const receipt = describeSection11Consequence("receipt", basis({ reason: "receipt-designation" }));
  assert.match(receipt, /^No input VAT \(Vorsteuer\), because /);
  assert.match(receipt, /§ 11/);

  // The statute has nothing to say about a non-document, so neither does this.
  const other = describeSection11Consequence("other", null);
  assert.match(other, /^Not a financial document/);
  assert.doesNotMatch(other, /§ ?11/);

  // A state the record is honestly in, never a failure or an empty field.
  const unknown = describeSection11Consequence("unknown", null);
  assert.match(unknown, /^Not established/);
  assert.doesNotMatch(unknown, /error|fail|missing/i);
  assert.equal(describeSection11Consequence(undefined, undefined), unknown);

  for (const sentence of [invoice, receipt, other, unknown]) {
    // One sentence: a single terminal full stop and no second sentence.
    assert.equal(sentence.split(/[.!?](\s|$)/).filter((s) => s && s.trim()).length, 1, sentence);
    assert.doesNotMatch(sentence, /\u2014/, "no em dashes in UI copy");
  }
});

test("describeSection11Consequence: an invoice addressed to somebody else is not your deduction", () => {
  const sentence = describeSection11Consequence("invoice", basis({ reason: "foreign-recipient" }));
  assert.match(sentence, /^No input VAT/);
  assert.doesNotMatch(sentence, /is deductible/);
});

test("the consequence sentences read on a Transaction row as well as on a File (#237)", () => {
  // No File-only phrasing: the Transaction surface borrows these words.
  for (const entry of [...Object.values(DOCUMENT_TYPES), DOCUMENTATION_STATES.invoice]) {
    assert.doesNotMatch(entry.summary, /\bthis document\b|\bthe document\b/i, entry.summary);
  }
  // A Transaction documented by an invoice reads identically to the File behind it.
  assert.equal(DOCUMENTATION_STATES.invoice.summary, DOCUMENT_TYPES.invoice.summary);
  assert.equal(
    describeSection11Consequence("invoice", basis()),
    describeDocumentationState("invoice").summary,
  );
});

test("the summaries say input VAT in English and keep the German in brackets only (#237)", () => {
  for (const entry of Object.values(DOCUMENT_TYPES)) {
    assert.doesNotMatch(entry.summary, /Rechnung|Steuersatz|Leistungsempf/, entry.summary);
    // Vorsteuer only ever as the bracketed citation after the English term.
    for (const match of entry.summary.matchAll(/Vorsteuer/g)) {
      assert.equal(entry.summary.slice(match.index - 1, match.index), "(", entry.summary);
    }
  }
});

test("the basis reads in English, with statutory German dosed into brackets (#237)", () => {
  const lines = [
    ...describeDocumentTypeBasis(
      basis({ reason: "zero-vat-with-stated-regime", zeroVatReason: "reverse-charge" }),
      "invoice",
    ),
    ...describeDocumentTypeBasis(
      basis({ reason: "foreign-recipient", regime: "kleinbetrag", grossTotal: 3_000 }),
      "invoice",
    ),
    ...describeDocumentTypeBasis(
      basis({ reason: "receipt-designation", recipientIdentity: "third-party" }),
      "receipt",
    ),
  ];
  for (const line of lines) {
    assert.doesNotMatch(line.label, /Steuersatz/, line.label);
    assert.doesNotMatch(line.text, /(?<!\()Steuersatz|(?<!\()Leistungsempfänger|(?<!\()Vorsteuer/, line.text);
  }
});

test("term glosses: each statutory term is written once and carries vocabulary only (#237)", () => {
  const expected = [
    "vorsteuer",
    "section11",
    "kleinbetragsrechnung",
    "steuersatz",
    "uid",
    "leistungsempfaenger",
    "reverseCharge",
  ];
  assert.deepEqual(Object.keys(TERM_GLOSSES).sort(), [...expected].sort());
  for (const key of expected) {
    const gloss = describeTerm(key);
    assert.equal(gloss, TERM_GLOSSES[key], "one definition, reused by reference");
    assert.ok(gloss.term.length > 0);
    assert.ok(gloss.text.length > 0);
    assert.ok(gloss.text.split(/\.(\s|$)/).filter((s) => s && s.trim()).length <= 2, key);
  }
  assert.equal(describeTerm("nonsense"), null);
});
