import test from "node:test";
import assert from "node:assert/strict";
import {
  describeDocumentType,
  describeDocumentationState,
  describeDocumentTypeBasis,
  describeMissingElements,
  describeSection11Element,
  buildSupplierRequestText,
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
    assert.equal(presentation.label, "Nicht bestimmt");
    assert.equal(presentation.tone, "unset");
    assert.ok(presentation.summary.length > 0);
    assert.ok(!presentation.summary.toLowerCase().includes("error"));
  }
});

test("describeDocumentType: an unrecognised value degrades to unknown rather than blank", () => {
  const presentation = describeDocumentType("gutschrift");
  assert.equal(presentation.type, "unknown");
  assert.equal(presentation.label, "Nicht bestimmt");
});

test("describeDocumentType: the four types each render with their own label and tone", () => {
  assert.deepEqual(
    ["invoice", "receipt", "other", "unknown"].map((t) => {
      const p = describeDocumentType(t);
      return [p.label, p.tone];
    }),
    [
      ["Rechnung", "positive"],
      ["Zahlungsbeleg", "warning"],
      ["Kein Beleg", "neutral"],
      ["Nicht bestimmt", "unset"],
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

test("describeSection11Element: elements read in German with their statute reference", () => {
  assert.deepEqual(describeSection11Element("invoice-number"), {
    element: "invoice-number",
    label: "Fortlaufende Nummer",
    citation: "§ 11 Abs 1 lit. h",
  });
  assert.deepEqual(describeSection11Element("supplier-vat-id"), {
    element: "supplier-vat-id",
    label: "UID-Nummer des liefernden Unternehmers",
    citation: "§ 11 Abs 1 lit. i",
  });
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
  assert.equal(missing.tone, "neutral");
  assert.notEqual(missing.heading, "Missing under § 11");
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
  assert.match(kleinbetrag.text, /Gross total read/);

  const standard = describeDocumentTypeBasis(
    basis({ regime: "standard", grossTotal: null }),
    "invoice",
  ).find((l) => l.id === "regime");
  assert.match(standard.text, /Abs 1/);
  assert.doesNotMatch(standard.text, /Gross total read/);
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
    assert.equal(presentation.label, "Nicht bestimmt");
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
      return [p.label, p.tone];
    }),
    [
      ["Rechnung", "positive"],
      ["Nur Zahlungsbeleg", "warning"],
      ["Kategorie statt Beleg", "neutral"],
      ["Kein Dokument", "unset"],
      ["Nicht bestimmt", "unset"],
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
