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
 * The four document types.
 *
 * ## Three kinds of German live in this file, and only one of them translates
 *
 * The product UI is English. These labels used to be German anyway, which is
 * where the Denglish came from: an English screen with `Nicht bestimmt` and
 * `Nur Zahlungsbeleg` on it. But not every German string here is the same kind
 * of string, and flattening them all to English would be just as wrong:
 *
 *   1. **UI chrome** — these labels, and the direction labels below. They name
 *      a state to the person reading the screen, so they follow the interface
 *      locale. `label` is the English default that non-React callers (the agent
 *      tools, the exports, the node tests) get; `labelKey` resolves through
 *      messages/{en,de}.json for anything rendering to a person.
 *   2. **Statutory terms**: Vorsteuer, Steuersatz, UID, Kleinbetragsrechnung
 *      and the nine `SECTION_11_ELEMENTS`. ADR-0007 (#134) settled that these
 *      translate like any other word (input VAT, VAT rate, VAT ID, simplified
 *      invoice), with the German in brackets on first use and not repeated.
 *      Only the citation "§ 11" itself never translates. What #237 fixed is
 *      the dose: the old summaries folded statutory German into English
 *      sentences, so every word was defensible and the screen still read as
 *      Denglish.
 *   3. **Outgoing correspondence**: `buildSupplierRequestText`. German because
 *      the RECIPIENT is an Austrian supplier, which has nothing to do with what
 *      language the user reads the app in. It stays German even for an English
 *      interface.
 *
 * `tone` is a presentation-neutral name a component maps to its own badge
 * variant: `unset` is deliberately its own tone rather than a shade of
 * `warning`, because "we have not established this" must not look like a
 * finding against the document.
 */
const DOCUMENT_TYPES = {
  invoice: {
    label: "Invoice",
    labelKey: "documents.type.invoice",
    tone: "positive",
    summary:
      "Input VAT (Vorsteuer) is deductible, because the invoice satisfies § 11 at its amount.",
  },
  receipt: {
    label: "Payment confirmation",
    labelKey: "documents.type.receipt",
    tone: "warning",
    summary:
      "No input VAT (Vorsteuer), because elements § 11 requires for an invoice are missing.",
  },
  other: {
    label: "Not a document",
    labelKey: "documents.type.other",
    tone: "neutral",
    summary: "Not a financial document, so there is nothing to deduct or chase.",
  },
  unknown: {
    label: "Not determined",
    labelKey: "documents.type.unknown",
    tone: "unset",
    summary:
      "Not established yet, because the record does not carry what would decide it.",
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
    labelKey: DOCUMENT_TYPES.invoice.labelKey,
    tone: "positive",
    // The sentence too, not only the label (#237): the File panel leads with
    // it, and a Transaction documented by that File must read identically.
    summary: DOCUMENT_TYPES.invoice.summary,
  },
  "receipt-only": {
    label: "Payment confirmation only",
    labelKey: "documents.state.receiptOnly",
    tone: "warning",
    summary:
      "Documented, but only by a payment confirmation. No Rechnung under § 11 was received, so no Vorsteuer may be claimed — ask the supplier.",
  },
  "no-receipt-category": {
    label: "Category instead of a document",
    labelKey: "documents.state.noReceiptCategory",
    tone: "neutral",
    summary:
      "Resolved by a no-receipt category rather than by a document. Nothing to chase, and nothing to deduct.",
  },
  undocumented: {
    label: "No document",
    labelKey: "documents.state.undocumented",
    tone: "unset",
    summary: "Nothing is attached, and no category resolves it.",
  },
  unknown: {
    label: DOCUMENT_TYPES.unknown.label,
    labelKey: DOCUMENT_TYPES.unknown.labelKey,
    tone: "unset",
    summary:
      "Documents are attached, but what they are is not established — the records do not yet carry what would decide it. Not a defect.",
  },
};

/**
 * The § 11 elements.
 *
 * `label` is the English interface word and `labelKey` its catalogue key, so
 * a German interface reads the German (ADR-0007). `german` is the statutory
 * name: it goes into the supplier mail, whose reader is Austrian, and into the
 * bracket after the English label on first use. `citation` is the audit
 * reference that makes the mail answerable instead of a vague ask for "a
 * proper invoice"; on the File panel it sits behind the click, not at rest.
 */
const SECTION_11_ELEMENTS = {
  "issue-date": {
    label: "Issue date",
    labelKey: "documents.element.issueDate",
    german: "Ausstellungsdatum",
    citation: "§ 11 Abs 1 lit. e / Abs 6 Z 3",
  },
  "supplier-name": {
    label: "Supplier name",
    labelKey: "documents.element.supplierName",
    german: "Name des liefernden Unternehmers",
    citation: "§ 11 Abs 1 lit. a / Abs 6 Z 1",
  },
  "supplier-address": {
    label: "Supplier address",
    labelKey: "documents.element.supplierAddress",
    german: "Anschrift des liefernden Unternehmers",
    citation: "§ 11 Abs 1 lit. a / Abs 6 Z 1",
  },
  description: {
    label: "Description of the goods or services",
    labelKey: "documents.element.description",
    german: "Handelsübliche Bezeichnung der Lieferung",
    citation: "§ 11 Abs 1 lit. c / Abs 6 Z 2",
  },
  steuersatz: {
    label: "VAT rate",
    labelKey: "documents.element.steuersatz",
    german: "Steuersatz",
    citation: "§ 11 Abs 6 Z 6 / Abs 1 lit. g",
  },
  "invoice-number": {
    label: "Sequential invoice number",
    labelKey: "documents.element.invoiceNumber",
    german: "Fortlaufende Nummer",
    citation: "§ 11 Abs 1 lit. h",
  },
  "supplier-vat-id": {
    label: "Supplier VAT ID",
    labelKey: "documents.element.supplierVatId",
    german: "UID-Nummer des liefernden Unternehmers",
    citation: "§ 11 Abs 1 lit. i",
  },
  recipient: {
    label: "Recipient name and address",
    labelKey: "documents.element.recipient",
    german: "Name und Anschrift des Leistungsempfängers",
    citation: "§ 11 Abs 1 lit. b",
  },
  "recipient-vat-id": {
    label: "Recipient VAT ID",
    labelKey: "documents.element.recipientVatId",
    german: "UID-Nummer des Leistungsempfängers",
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
    "No gross total could be read, and the total is what picks the § 11 regime, so no verdict was given rather than a guessed one.",
  "section-11-satisfied": "Every element § 11 requires at this amount is present.",
  "zero-vat-with-stated-regime":
    "No Austrian VAT rate, and the document states why it carries none: that is an invoice, not a defective one.",
  "receipt-designation":
    "The document calls itself a payment confirmation, and an element § 11 requires at this amount is absent.",
  "no-vat-no-invoice-identity":
    "No VAT rate, no VAT ID and no invoice number: the shape of a payment confirmation.",
  "missing-decisive-elements":
    "An element § 11 requires at this amount is missing.",
  "foreign-recipient":
    "Every element § 11 requires is present, but the recipient (Leistungsempfänger) it names is not you. The supply was rendered to somebody else's business, so the input VAT is theirs (§ 12 Abs 1 Z 1). If this recipient IS you under another name, confirm it and the document counts again.",
  "own-outgoing-document":
    "You issued this document, so a § 11 gap here is a defect in your own invoicing, never a supplier to chase.",
  "legacy-record-undecidable":
    "Only fields this record predates would decide it, so it stays undetermined instead of guessed.",
};

/** Why an absent Austrian rate is lawful, when the document says so. */
const ZERO_VAT_TEXT = {
  "reverse-charge":
    "Reverse charge: the document states that the recipient owes the tax, so no Austrian VAT rate (Steuersatz) is printed.",
  exempt: "The document states an exemption, so it lawfully carries no VAT rate.",
  "foreign-supplier":
    "The supplier's VAT ID (UID) is not Austrian, so Austria levies no rate on this supply.",
  "cross-border-b2b":
    "No supplier VAT ID, but your Austrian VAT ID is printed: the shape of a supply taxed outside Austria.",
  "zero-rated": "The rate is stated and it is zero: an answer, not an absence.",
};

const SELF_DESIGNATION_CLASS_LABEL = {
  invoice: "an invoice",
  receipt: "a payment confirmation",
  "credit-note": "a credit document (Gutschrift)",
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
  if (!known) {
    return { element, label: element, german: element, citation: "§ 11 UStG" };
  }
  return {
    element,
    label: known.label,
    labelKey: known.labelKey,
    german: known.german,
    citation: known.citation,
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

  // `german`, never `label`: the reader is an Austrian supplier (ADR-0007).
  const lines = items.map((item) => `- ${item.german} (${item.citation})`);
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
 * The missing-element list, which follows the verdict (#237).
 *
 * On a receipt it is the defect to chase, and the supplier request is worth
 * offering. On an invoice it is not shown at all: a reverse-charge invoice
 * lawfully prints no Austrian rate and often no sequential number, and listing
 * those as absences argues with a document that is correct. On an unknown (or
 * not-a-document) File it is not shown either, because reporting elements
 * missing from a document we have not classified states a defect we cannot
 * stand behind. The stored list is untouched; only what is shown follows the
 * verdict.
 *
 * @param {string | null | undefined} type
 * @param {string[] | null | undefined} elements
 * @returns {import("./document-type-presentation").MissingElementsPresentation}
 */
function describeMissingElements(type, elements) {
  const { type: resolvedType } = describeDocumentType(type);

  if (resolvedType === "receipt") {
    return {
      heading: "Missing under § 11",
      tone: "warning",
      note: "Ask the supplier for an invoice that names these.",
      items: orderElements(elements),
      requestText: buildSupplierRequestText(elements),
      isDefect: true,
    };
  }

  return {
    heading: "Missing under § 11",
    tone: resolvedType === "invoice" ? "neutral" : "unset",
    note: "",
    items: [],
    requestText: null,
    isDefect: false,
  };
}

/**
 * The one sentence the § 11 field shows at rest (#237): the answer first, the
 * reason in the same clause.
 *
 * It is the type's own summary, so the File panel, the badge tooltip and a
 * Transaction documented by the File all say the same thing. The one place the
 * stored basis changes it is an invoice addressed to somebody else: § 11 is
 * satisfied, but the input VAT is not the user's (§ 12), and leading with
 * "deductible" there would be the wrong answer first.
 *
 * @param {string | null | undefined} type
 * @param {import("./document-type-presentation").BasisInput | null | undefined} basis
 * @returns {string}
 */
function describeSection11Consequence(type, basis) {
  const presentation = describeDocumentType(type);
  if (presentation.type === "invoice" && basis && basis.reason === "foreign-recipient") {
    return "No input VAT (Vorsteuer) for you, because the invoice is addressed to somebody else.";
  }
  return presentation.summary;
}

/**
 * The statutory vocabulary an EPU may not know cold, each written once (#237).
 *
 * These carry vocabulary only, never findings: nothing a user needs in order
 * to act lives only here, because a hover gloss is unreachable on touch. Every
 * surface that glosses one of these terms reads it from this table, so the
 * same term cannot carry two wordings on two screens.
 */
const TERM_GLOSSES = {
  vorsteuer: {
    term: "Input VAT",
    german: "Vorsteuer",
    text: "The VAT you paid a supplier, which a VAT-registered business can reclaim from the tax office. It needs an invoice that satisfies § 11.",
  },
  section11: {
    term: "§ 11 UStG",
    german: null,
    text: "The section of the Austrian VAT Act that lists what an invoice must print. Only a document that prints them carries an input VAT deduction.",
  },
  kleinbetragsrechnung: {
    term: "Simplified invoice",
    german: "Kleinbetragsrechnung",
    text: "An invoice of up to 400 euros gross. It may leave out the VAT ID, the sequential number and the recipient (§ 11 Abs 6).",
  },
  steuersatz: {
    term: "VAT rate",
    german: "Steuersatz",
    text: "The percentage of VAT charged, such as 20, 13 or 10 percent in Austria. An invoice must print it, or state why there is none.",
  },
  uid: {
    term: "VAT ID",
    german: "UID",
    text: "A business's VAT identification number, ATU and eight digits in Austria. Invoices above 400 euros must print the supplier's.",
  },
  leistungsempfaenger: {
    term: "Recipient",
    german: "Leistungsempfänger",
    text: "The business the goods or services were supplied to. Only the recipient named on an invoice may claim its input VAT.",
  },
  reverseCharge: {
    term: "Reverse charge",
    german: "Übergang der Steuerschuld",
    text: "The recipient, not the supplier, owes the VAT on the supply. The invoice then lawfully prints no Austrian VAT rate.",
  },
};

/**
 * @param {string} key
 * @returns {import("./document-type-presentation").TermGloss | null}
 */
function describeTerm(key) {
  return Object.prototype.hasOwnProperty.call(TERM_GLOSSES, key) ? TERM_GLOSSES[key] : null;
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
        label: "Result",
        text: "Not classified yet: this record was stored before the § 11 classifier ran. It is classified the next time the file is extracted.",
      },
    ];
  }

  /** @type {import("./document-type-presentation").BasisLine[]} */
  const lines = [];

  lines.push({
    id: "verdict",
    label: "Result",
    text:
      REASON_TEXT[basis.reason] ??
      "Decided on rules this screen does not yet have wording for.",
  });

  if (basis.regime) {
    const limit = formatEuroCents(KLEINBETRAG_LIMIT_CENTS);
    const scope =
      basis.regime === "kleinbetrag"
        ? `Up to ${limit} a simplified invoice (Kleinbetragsrechnung, § 11 Abs 6) is enough: it needs no VAT ID, invoice number or recipient.`
        : `Above ${limit} the full rules apply (§ 11 Abs 1): the invoice must also show an invoice number, the supplier's VAT ID and you as recipient.`;
    lines.push({
      id: "regime",
      label: "Rules",
      text:
        basis.grossTotal == null
          ? scope
          : `${scope} This document's total: ${formatEuroCents(Math.abs(basis.grossTotal))}.`,
    });
  }

  if (basis.selfDesignation) {
    lines.push({
      id: "heading",
      label: "Title",
      text: describeSelfDesignation(basis, resolvedType),
    });
  }

  if (basis.zeroVatReason && ZERO_VAT_TEXT[basis.zeroVatReason]) {
    lines.push({
      id: "zero-vat",
      label: "No VAT rate",
      text: ZERO_VAT_TEXT[basis.zeroVatReason],
    });
  }

  // Carried on every verdict, not only the one whose REASON it is: a document
  // that fails § 11 for another reason is still addressed to whoever it is
  // addressed to, and that is the fact with the § 12 consequence.
  if (basis.recipientIdentity === "third-party" && basis.reason !== "foreign-recipient") {
    lines.push({
      id: "recipient",
      label: "Recipient",
      text: "The document names a recipient (Leistungsempfänger) who is not you. Whatever else it is, its VAT is not your input VAT.",
    });
  }

  if (basis.degraded) {
    lines.push({
      id: "degraded",
      label: "Data",
      text: "Some elements could not be judged from this record. It improves the next time the file is extracted; it is not a defect on the document.",
    });
  }

  return lines;
}

/**
 * Which way a document points, in the words an Austrian EPU reads them in.
 *
 * `unknown` is a real state and by far the most common one: direction is
 * decided by comparing the document's parties against the user's own identity
 * data, and a document those data cannot place has no direction at all. Until
 * #233 that state was rendered as a POSITIVE amount, which is what income
 * looks like — so an undirected purchase read as a sale, in green, with
 * nothing on the screen saying otherwise.
 */
const INVOICE_DIRECTIONS = {
  incoming: {
    label: "Incoming invoice",
    labelKey: "documents.direction.incoming",
    tone: "neutral",
    summary: "A purchase: the money left your account.",
    /** For prose, where the badge label would read as a proper noun. */
    nounPhrase: "a purchase",
    /** How the amount reads on a list. */
    sign: "negative",
  },
  outgoing: {
    label: "Outgoing invoice",
    labelKey: "documents.direction.outgoing",
    tone: "neutral",
    summary: "A sale: the money came in.",
    nounPhrase: "a sale",
    sign: "positive",
  },
  unknown: {
    label: "Direction not determined",
    labelKey: "documents.direction.unknown",
    tone: "unset",
    summary:
      "Nothing places this document as a purchase or a sale — your identity data did not match either party on it. Its amount is shown unsigned rather than guessed.",
    sign: "unsigned",
  },
};

/** Resolve a stored direction, treating anything unrecognised as unknown. */
function describeInvoiceDirection(direction) {
  const key =
    direction === "incoming" || direction === "outgoing" ? direction : "unknown";
  return { direction: key, ...INVOICE_DIRECTIONS[key] };
}

/** Why a file is on the direction review list, and what to do about it (#233). */
const DIRECTION_REVIEW_TEXT = {
  conflict:
    "The direction contradicts a transaction this file is attached to. One of the two is wrong: an Eingangsrechnung belongs on money going out, an Ausgangsrechnung on money coming in.",
  "unknown-direction":
    "No direction was ever established for this document, so nothing downstream can be right about it — the agent read tools and the accountant export both take the direction at face value.",
};

/**
 * The direction-review chip, or null when there is nothing to review.
 *
 * Takes the stored fields rather than the file so it can be unit-tested, and
 * so a caller cannot accidentally pass a file that has not loaded yet.
 */
function describeDirectionReview(review) {
  if (!review || review.needsDirectionReview !== true) return null;

  const reason =
    review.directionReviewReason === "conflict" ? "conflict" : "unknown-direction";
  const suggested =
    review.directionSuggested === "incoming" || review.directionSuggested === "outgoing"
      ? describeInvoiceDirection(review.directionSuggested)
      : null;

  return {
    reason,
    label: reason === "conflict" ? "Direction conflicts" : "Direction open",
    labelKey:
      reason === "conflict"
        ? "documents.directionReview.conflict"
        : "documents.directionReview.open",
    tone: reason === "conflict" ? "warning" : "unset",
    text: DIRECTION_REVIEW_TEXT[reason],
    /** What the linked transactions say it should be, when they agree. */
    suggestion: suggested
      ? `The transaction it is attached to says this is ${suggested.nounPhrase}.`
      : null,
    suggestedDirection: suggested ? suggested.direction : null,
  };
}

/** The § 12 chip for a document addressed to somebody else (#229). */
function describeForeignRecipient(foreignRecipient) {
  if (foreignRecipient !== true) return null;

  return {
    label: "Nicht auf Sie ausgestellt",
    tone: "warning",
    text: "This document names a Leistungsempfänger who is not you, so no Vorsteuer on it is yours (§ 12 Abs 1 Z 1). Its VAT is kept out of the UVA and it is not offered as a match for your transactions. If the recipient is you under another name — a maiden name, a c/o address, a misread line — confirm it and both resume.",
  };
}

/** "date", "address and date", "address, date and partner". */
function joinFieldNames(fields) {
  if (fields.length <= 1) return fields[0] ?? "";
  return `${fields.slice(0, -1).join(", ")} and ${fields[fields.length - 1]}`;
}

/**
 * The detail panel's own name for each response key the repair can flag
 * (#301). The stored list keeps the response's keys so it still lines up with
 * the parse; only what a reader sees is translated. Several keys land on one
 * row — `date` and `date_raw` are both "Document Date" — and a key with no row
 * here is shown as it is rather than hidden.
 */
const REPAIR_FIELD_LABEL = {
  date: "Document Date",
  date_raw: "Document Date",
  amount: "Amount",
  amount_raw: "Amount",
  tipAmount: "Tip",
  vatPercent: "VAT",
  vatPercent_raw: "VAT",
  partner: "Partner",
  partner_raw: "Partner",
  name: "Partner",
  vatId: "VAT ID",
  vatId_raw: "VAT ID",
  iban: "IBAN",
  iban_raw: "IBAN",
  address: "Address",
  address_raw: "Address",
  website: "Website",
  website_raw: "Website",
  description: "Line items",
  label: "Additional fields",
  value: "Additional fields",
  rawValue: "Additional fields",
  invoiceNumber: "Invoice number",
  selfDesignation: "Document title",
  currency: "Currency",
  rawText: "Extracted text",
};

function repairFieldLabels(fields) {
  return [...new Set(fields.map((field) => REPAIR_FIELD_LABEL[field] ?? field))];
}

/**
 * A transcription the JSON repair had to guess at (#275).
 *
 * The model's response did not parse; repairing it meant deciding whether a
 * backslash followed by `b f n r t` was an escape the model wrote or two
 * characters the document prints. Those are the same two bytes, so the reading
 * JSON defines was taken — and the resulting value carries a control character
 * where the document may simply carry a backslash. Nothing downstream can tell,
 * which is the whole reason this says so on screen.
 */
function describeRepairAmbiguity(review) {
  if (!review || review.needsRepairReview !== true) return null;

  const fields = Array.isArray(review.repairAmbiguousFields)
    ? review.repairAmbiguousFields.filter(
        (field) => typeof field === "string" && field.length > 0,
      )
    : [];

  const labels = repairFieldLabels(fields);
  const where = labels.length > 0 ? `in ${joinFieldNames(labels)}` : "in a transcribed field";

  return {
    label: "Transcription may be misread",
    tone: "warning",
    /**
     * The fields to look at, as the response's keys, so a caller can point at
     * them directly. The text names them by the panel's labels instead (#301).
     */
    fields,
    text: `The model's response was malformed and had to be repaired before it could be read. Doing so meant choosing a reading for a backslash ${where}: a backslash followed by b, f, n, r or t is an escape sequence to JSON, but a document can simply print those two characters. It was read as JSON defines it, so the stored text may not be what the document says. Check ${labels.length > 0 ? joinFieldNames(labels) : "the fields"} against the document.`,
  };
}

/**
 * A printed Rate Group block the receipt's RKSV Code contradicts (#166).
 *
 * The printed block is what is stored; the flag says the two readings of the
 * same split disagree, and at which rates. The words live in the message
 * catalogues, so this returns keys and the rates, not text.
 */
function describeRksvCodeReview(review) {
  if (!review || review.needsRksvCodeReview !== true) return null;

  const rates = Array.isArray(review.rksvCodeDisagreeingRates)
    ? review.rksvCodeDisagreeingRates.filter((rate) => typeof rate === "number" && Number.isFinite(rate))
    : [];

  return {
    tone: "warning",
    labelKey: "files.extracted.rksvCodeReview.label",
    textKey: "files.extracted.rksvCodeReview.text",
    rates,
  };
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
    return `The document prints ${quoted}. Evidence only: the § 11 test decides.`;
  }

  const reads = SELF_DESIGNATION_CLASS_LABEL[designationClass];

  if (designationClass === "invoice" && resolvedType !== "invoice") {
    return `The document prints ${quoted}, which reads as ${reads}. That was read and overruled by the document's structure: § 11 is tested at the amount, not at the title.`;
  }

  if (designationClass === "receipt" && resolvedType === "invoice") {
    return `The document prints ${quoted}, which reads as ${reads}. That was read and overruled by the document's structure: it satisfies § 11 at its amount.`;
  }

  if (designationClass === "credit-note") {
    return `The document prints ${quoted}, which reads as ${reads}, not an invoice. Evidence only; the § 11 test decides.`;
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
  describeSection11Consequence,
  TERM_GLOSSES,
  describeTerm,
  INVOICE_DIRECTIONS,
  describeInvoiceDirection,
  describeDirectionReview,
  describeForeignRecipient,
  describeRepairAmbiguity,
  describeRksvCodeReview,
};
