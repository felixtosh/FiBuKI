/**
 * How a § 11 classification reads on screen (#205).
 *
 * The verdict, the basis behind it and the missing elements are decided by
 * `functions/src/documents/classifyDocumentType.ts` and stored on the file.
 * Nothing here re-derives any of that — this module only turns the stored
 * enums into words, and it is the single place those words live so the file
 * surfaces and the transaction surfaces cannot describe the same document
 * differently.
 *
 * Two rules shape the wording:
 *
 *   `unknown` is not an error and not an empty field. It is the common case
 *   until the backfill and the re-extraction sweep run, and it has to read as
 *   "not established" — a state the record is honestly in, not a failure.
 *
 *   A missing element is only a defect when the document is a receipt. A
 *   reverse-charge invoice lawfully prints no Austrian rate and often no
 *   sequential number; it is an invoice, and its unprinted elements are
 *   reported, never held against it.
 *
 * Plain data in, plain data out — no React, no Firestore, no formatting of a
 * component's choosing — so the whole vocabulary is testable with node --test.
 */

/** § 11 Abs 6: the Kleinbetragsrechnung ceiling, gross. Mirrors the classifier. */
const KLEINBETRAG_LIMIT_CENTS = 40_000;

/**
 * The four document types, in the words an Austrian EPU reads them in.
 *
 * `tone` is a presentation-neutral name a component maps to its own badge
 * variant: `unset` is deliberately its own tone rather than a shade of
 * `warning`, because "we have not established this" must not look like a
 * finding against the document.
 */
const DOCUMENT_TYPES = {
  invoice: {
    label: "Rechnung",
    tone: "positive",
    summary: "Satisfies § 11 UStG at this amount — the Vorsteuer is deductible.",
  },
  receipt: {
    label: "Zahlungsbeleg",
    tone: "warning",
    summary:
      "Proves the payment, but is not a Rechnung under § 11 — it carries no right to Vorsteuer.",
  },
  other: {
    label: "Kein Beleg",
    tone: "neutral",
    summary: "Not a financial document, so § 11 has nothing to say about it.",
  },
  unknown: {
    label: "Nicht bestimmt",
    tone: "unset",
    summary:
      "The document type is not established — the record does not yet carry what would decide it. Not a defect.",
  },
};

/**
 * How a TRANSACTION is documented (#207), in the same words.
 *
 * `deriveDocumentationState` in `functions/src/documents/documentationState.ts`
 * decides this and the trigger stores it; nothing here re-derives it. The two
 * states that carry the whole point of #96:
 *
 *   `invoice` borrows the document type's own label, so a transaction and the
 *   file behind it never read as two different things. A transaction holding
 *   both a receipt and an invoice lands here — the extra receipt never
 *   downgrades a good line.
 *
 *   `receipt-only` is the line to chase, and it is the only state the queue
 *   holds.
 *
 * `no-receipt-category` gets its own label rather than a shade of green: a
 * line resolved by a category is not a line documented by a Rechnung, and the
 * operator has to be able to tell them apart at a glance.
 */
const DOCUMENTATION_STATES = {
  invoice: {
    label: DOCUMENT_TYPES.invoice.label,
    tone: "positive",
    summary:
      "Documented by an invoice that satisfies § 11 at its amount — the Vorsteuer is deductible.",
  },
  "receipt-only": {
    label: "Nur Zahlungsbeleg",
    tone: "warning",
    summary:
      "Documented, but only by a payment confirmation. No Rechnung under § 11 was received, so no Vorsteuer may be claimed — ask the supplier.",
  },
  "no-receipt-category": {
    label: "Kategorie statt Beleg",
    tone: "neutral",
    summary:
      "Resolved by a no-receipt category rather than by a document. Nothing to chase, and nothing to deduct.",
  },
  undocumented: {
    label: "Kein Dokument",
    tone: "unset",
    summary: "Nothing is attached, and no category resolves it.",
  },
  unknown: {
    label: DOCUMENT_TYPES.unknown.label,
    tone: "unset",
    summary:
      "Documents are attached, but what they are is not established — the records do not yet carry what would decide it. Not a defect.",
  },
};

/**
 * The § 11 elements, named the way they have to be named in a mail to an
 * Austrian supplier. Labels and citations are carried over from the
 * classifier's own element list rather than restated — the statute reference
 * is what makes the request answerable instead of a vague ask for "a proper
 * invoice".
 */
const SECTION_11_ELEMENTS = {
  "issue-date": {
    label: "Ausstellungsdatum",
    citation: "§ 11 Abs 1 lit. e / Abs 6 Z 3",
  },
  "supplier-name": {
    label: "Name des liefernden Unternehmers",
    citation: "§ 11 Abs 1 lit. a / Abs 6 Z 1",
  },
  "supplier-address": {
    label: "Anschrift des liefernden Unternehmers",
    citation: "§ 11 Abs 1 lit. a / Abs 6 Z 1",
  },
  description: {
    label: "Handelsübliche Bezeichnung der Lieferung",
    citation: "§ 11 Abs 1 lit. c / Abs 6 Z 2",
  },
  steuersatz: {
    label: "Steuersatz",
    citation: "§ 11 Abs 6 Z 6 / Abs 1 lit. g",
  },
  "invoice-number": {
    label: "Fortlaufende Nummer",
    citation: "§ 11 Abs 1 lit. h",
  },
  "supplier-vat-id": {
    label: "UID-Nummer des liefernden Unternehmers",
    citation: "§ 11 Abs 1 lit. i",
  },
  recipient: {
    label: "Name und Anschrift des Leistungsempfängers",
    citation: "§ 11 Abs 1 lit. b",
  },
  "recipient-vat-id": {
    label: "UID-Nummer des Leistungsempfängers",
    citation: "§ 11 Abs 1 Z 2",
  },
};

/** Statute order, so two documents never list the same defects differently. */
const SECTION_11_ELEMENT_ORDER = [
  "issue-date",
  "supplier-name",
  "supplier-address",
  "description",
  "steuersatz",
  "invoice-number",
  "supplier-vat-id",
  "recipient",
  "recipient-vat-id",
];

/** One sentence per verdict the classifier can reach. */
const REASON_TEXT = {
  "not-a-financial-document":
    "Read as not a financial document, so § 11 does not apply to it.",
  "no-gross-total":
    "No gross total could be read, and the total is what picks the § 11 regime — so no verdict was given rather than a guessed one.",
  "section-11-satisfied": "Every element § 11 requires at this amount is present.",
  "zero-vat-with-stated-regime":
    "No Austrian Steuersatz, and the document states why it carries none — that is an invoice, not a defective one.",
  "receipt-designation":
    "The document calls itself a payment confirmation, and an element § 11 requires at this amount is absent.",
  "no-vat-no-invoice-identity":
    "No Steuersatz, no UID and no invoice number — the shape of a payment confirmation.",
  "missing-decisive-elements":
    "An element § 11 requires at this amount is missing.",
  "own-outgoing-document":
    "You issued this document, so a § 11 gap here is a defect in your own invoicing — never a supplier to chase.",
  "legacy-record-undecidable":
    "Only fields this record predates would decide it, so it stays undetermined instead of guessed.",
};

/** Why an absent Austrian rate is lawful, when the document says so. */
const ZERO_VAT_TEXT = {
  "reverse-charge":
    "Reverse charge: the document states that the recipient owes the tax, so no Austrian Steuersatz is printed.",
  exempt: "The document states an exemption, so it lawfully carries no Steuersatz.",
  "foreign-supplier":
    "The supplier's UID is not Austrian, so Austria levies no rate on this supply.",
  "cross-border-b2b":
    "No supplier UID, but your Austrian UID is printed — the shape of a supply taxed outside Austria.",
  "zero-rated": "The rate is stated and it is zero — an answer, not an absence.",
};

const SELF_DESIGNATION_CLASS_LABEL = {
  invoice: "an invoice",
  receipt: "a payment confirmation",
  "credit-note": "a Gutschrift",
};

function formatEuroCents(cents) {
  return new Intl.NumberFormat("de-AT", {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100);
}

/**
 * @param {string | null | undefined} type
 * @returns {import("./document-type-presentation").DocumentTypePresentation}
 */
function describeDocumentType(type) {
  // An absent field is the same state as an explicit `unknown`: every file
  // stored before the classifier shipped has none, and reporting those as
  // missing data would make the honest majority of the corpus look broken.
  const key = type && DOCUMENT_TYPES[type] ? type : "unknown";
  return { type: key, ...DOCUMENT_TYPES[key] };
}

/**
 * @param {string | null | undefined} state
 * @returns {import("./document-type-presentation").DocumentationStatePresentation}
 */
function describeDocumentationState(state) {
  // An absent field is "never checked", not "nothing attached" — every row
  // written before #104 carries none, and reading that as `undocumented`
  // would tell the operator a documented transaction has no document.
  const key = state && DOCUMENTATION_STATES[state] ? state : "unknown";
  return { state: key, ...DOCUMENTATION_STATES[key] };
}

/**
 * @param {string} element
 * @returns {import("./document-type-presentation").Section11ElementPresentation}
 */
function describeSection11Element(element) {
  const known = SECTION_11_ELEMENTS[element];
  // An element the backend learns to report before this module learns to name
  // it still has to appear: silently dropping it would understate the defect.
  return {
    element,
    label: known ? known.label : element,
    citation: known ? known.citation : "§ 11 UStG",
  };
}

/**
 * The German text of a request to the supplier, ready to paste into a mail.
 *
 * @param {string[] | null | undefined} elements
 * @returns {string | null}
 */
function buildSupplierRequestText(elements) {
  const items = orderElements(elements);
  if (items.length === 0) return null;

  const lines = items.map((item) => `- ${item.label} (${item.citation})`);
  return [
    "Bitte übermitteln Sie uns eine Rechnung gemäß § 11 UStG.",
    "Auf dem vorliegenden Beleg fehlen folgende Pflichtangaben:",
    ...lines,
  ].join("\n");
}

function orderElements(elements) {
  if (!Array.isArray(elements)) return [];
  const seen = new Set();
  const unique = [];
  for (const element of elements) {
    if (typeof element !== "string" || seen.has(element)) continue;
    seen.add(element);
    unique.push(element);
  }
  return unique
    .sort((a, b) => {
      const rankA = SECTION_11_ELEMENT_ORDER.indexOf(a);
      const rankB = SECTION_11_ELEMENT_ORDER.indexOf(b);
      return (
        (rankA === -1 ? SECTION_11_ELEMENT_ORDER.length : rankA) -
        (rankB === -1 ? SECTION_11_ELEMENT_ORDER.length : rankB)
      );
    })
    .map(describeSection11Element);
}

/**
 * The missing-element list, framed by what the document turned out to be.
 *
 * The same list means two different things. On a receipt it is the defect to
 * chase, and the supplier request is worth offering. On an invoice — a
 * reverse-charge one above all — it is only what the document does not print,
 * and calling that a defect would send a mail asking for something the
 * supplier is right not to have shown.
 *
 * @param {string | null | undefined} type
 * @param {string[] | null | undefined} elements
 * @returns {import("./document-type-presentation").MissingElementsPresentation}
 */
function describeMissingElements(type, elements) {
  const { type: resolvedType } = describeDocumentType(type);
  const items = orderElements(elements);

  if (resolvedType === "receipt") {
    return {
      heading: "Missing under § 11",
      tone: "warning",
      note: "Ask the supplier for an invoice that names these.",
      items,
      requestText: buildSupplierRequestText(elements),
      isDefect: true,
    };
  }

  if (resolvedType === "invoice") {
    return {
      heading: "Not printed on the document",
      tone: "neutral",
      note: "This document satisfies § 11 at its amount. These elements are simply not shown on it.",
      items,
      requestText: null,
      isDefect: false,
    };
  }

  return {
    heading: "Not shown on the record",
    tone: "unset",
    note: "The document type is not established, so these are reported, not held against it.",
    items,
    requestText: buildSupplierRequestText(elements),
    isDefect: false,
  };
}

/**
 * Why the classifier decided as it did, in lines an operator can judge.
 *
 * @param {import("./document-type-presentation").BasisInput | null | undefined} basis
 * @param {string | null | undefined} type
 * @returns {import("./document-type-presentation").BasisLine[]}
 */
function describeDocumentTypeBasis(basis, type) {
  const { type: resolvedType } = describeDocumentType(type);

  if (!basis) {
    return [
      {
        id: "verdict",
        label: "Verdict",
        text: "Not classified yet — this record was stored before the § 11 classifier ran. It is classified the next time the file is extracted.",
      },
    ];
  }

  /** @type {import("./document-type-presentation").BasisLine[]} */
  const lines = [];

  lines.push({
    id: "verdict",
    label: "Verdict",
    text:
      REASON_TEXT[basis.reason] ??
      "Decided on rules this screen does not yet have wording for.",
  });

  if (basis.regime) {
    const limit = formatEuroCents(KLEINBETRAG_LIMIT_CENTS);
    const scope =
      basis.regime === "kleinbetrag"
        ? `Kleinbetragsrechnung — § 11 Abs 6 applies up to ${limit}: no UID, no sequential number, no recipient required.`
        : `§ 11 Abs 1 applies above ${limit}: sequential number, supplier UID and recipient are required too.`;
    lines.push({
      id: "regime",
      label: "Regime",
      text:
        basis.grossTotal == null
          ? scope
          : `${scope} Gross total read: ${formatEuroCents(Math.abs(basis.grossTotal))}.`,
    });
  }

  if (basis.selfDesignation) {
    lines.push({
      id: "heading",
      label: "Heading",
      text: describeSelfDesignation(basis, resolvedType),
    });
  }

  if (basis.zeroVatReason && ZERO_VAT_TEXT[basis.zeroVatReason]) {
    lines.push({
      id: "zero-vat",
      label: "No Steuersatz",
      text: ZERO_VAT_TEXT[basis.zeroVatReason],
    });
  }

  if (basis.degraded) {
    lines.push({
      id: "degraded",
      label: "Record",
      text: "Some elements could not be judged from this record. It improves the next time the file is extracted — it is not a defect on the document.",
    });
  }

  return lines;
}

/**
 * The printed heading is evidence, never the verdict — so when the structure
 * disagrees with it, the screen has to say so. A document titled `Rechnung`
 * that fails § 11 at its amount is otherwise an argument with the operator.
 */
function describeSelfDesignation(basis, resolvedType) {
  const quoted = `»${basis.selfDesignation}«`;
  const designationClass = basis.selfDesignationClass;

  if (!designationClass) {
    return `The document prints ${quoted}. Evidence only — the § 11 test decides.`;
  }

  const reads = SELF_DESIGNATION_CLASS_LABEL[designationClass];

  if (designationClass === "invoice" && resolvedType !== "invoice") {
    return `The document prints ${quoted}, which reads as ${reads}. That was read and overruled by the document's structure: § 11 is tested at the amount, not at the title.`;
  }

  if (designationClass === "receipt" && resolvedType === "invoice") {
    return `The document prints ${quoted}, which reads as ${reads}. That was read and overruled by the document's structure: it satisfies § 11 at its amount.`;
  }

  if (designationClass === "credit-note") {
    return `The document prints ${quoted}, which reads as ${reads} — not a Rechnung. Evidence only; the § 11 test decides.`;
  }

  return `The document prints ${quoted}, which reads as ${reads}, and the § 11 test agrees.`;
}

module.exports = {
  KLEINBETRAG_LIMIT_CENTS,
  DOCUMENT_TYPES,
  SECTION_11_ELEMENTS,
  SECTION_11_ELEMENT_ORDER,
  DOCUMENTATION_STATES,
  describeDocumentType,
  describeDocumentationState,
  describeSection11Element,
  describeMissingElements,
  describeDocumentTypeBasis,
  buildSupplierRequestText,
};
