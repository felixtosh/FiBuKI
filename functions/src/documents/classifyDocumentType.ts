/**
 * Is this document a *Rechnung* under § 11 UStG, or only a payment
 * confirmation? (#104)
 *
 * Pure: plain facts in, verdict out. No Firestore handle, no model call, no
 * I/O — a sibling in style to `uva/calculateUva.ts`, and for the same reason.
 * The whole rule table is here so it can be tested exhaustively without
 * fixtures or network.
 *
 * Austrian law has two invoice regimes and the threshold between them is this
 * discriminator's hinge:
 *
 *   § 11 Abs 6 — Kleinbetragsrechnung, gross total up to 400 EUR. Issue date,
 *   supplier name and address, quantity and description, delivery date or
 *   period, *Entgelt und Steuerbetrag in einer Summe*, and the Steuersatz. No
 *   supplier UID. No sequential number. No recipient.
 *
 *   § 11 Abs 1 — over 400 EUR. All of the above, plus a fortlaufende Nummer
 *   (lit. h), the supplier's UID (lit. i), and the recipient's name and
 *   address (lit. b) — with the recipient's UID additionally required over
 *   10 000 EUR.
 *
 * So below the threshold the discriminator is the VAT rate alone. Applying
 * the UID test there would demote every legitimate small invoice and fill the
 * chase queue with work that does not exist.
 *
 * The document's own printed heading is evidence, never the verdict: a
 * document titled `Rechnung` that fails § 11 at its amount is classified on
 * the structure, with the title recorded in the basis.
 */

import type {
  DocumentFacts,
  DocumentTypeBasis,
  DocumentTypeReason,
  DocumentTypeResult,
  Section11Element,
  Section11Regime,
  SelfDesignationClass,
  ZeroVatReason,
} from "./types";
import { KNOWN_AUSTRIAN_RATES } from "../uva/rateSet";

/**
 * § 11 Abs 6: the Kleinbetragsrechnung ceiling, gross. The statute reads
 * "nicht übersteigt", so exactly 400,00 EUR is still a Kleinbetragsrechnung.
 */
export const KLEINBETRAG_LIMIT_CENTS = 40_000;

/** § 11 Abs 1 Z 2: over this gross figure the recipient's UID is required too. */
export const RECIPIENT_VAT_ID_LIMIT_CENTS = 1_000_000;

/**
 * The elements whose absence actually demotes a document, per regime.
 *
 * Deliberately narrow. The other § 11 elements are reported in
 * `missingElements` for the supplier request but never drive the verdict:
 * extraction reports them unreliably enough that testing them would demote
 * good invoices.
 */
const DECISIVE_ELEMENTS: Record<Section11Regime, Section11Element[]> = {
  kleinbetrag: ["steuersatz"],
  standard: ["steuersatz", "supplier-vat-id", "invoice-number"],
};

/** Phrases that say why a document carries no VAT. Read only when no rate is printed. */
const REVERSE_CHARGE_MARKERS = [
  "reverse charge",
  "reverse-charge",
  "reverse charged",
  "steuerschuldnerschaft des leistungsempfängers",
  "übergang der steuerschuld",
  "uebergang der steuerschuld",
  "umkehr der steuerschuld",
  "innergemeinschaftliche lieferung",
  "intra-community supply",
  "intracommunity supply",
  "vat to be accounted for by the recipient",
];

const EXEMPTION_MARKERS = [
  "kleinunternehmer",
  "steuerbefreit",
  "umsatzsteuerbefreit",
  "steuerfrei",
  "nicht umsatzsteuerpflichtig",
  "differenzbesteuerung",
  "vat exempt",
  "exempt from vat",
  "tax exempt",
  "zero-rated",
  "zero rated",
];

/** Headings, most specific class first — a Gutschrift is not a Rechnung. */
const DESIGNATION_PATTERNS: Array<[SelfDesignationClass, string[]]> = [
  ["credit-note", ["gutschrift", "credit note", "credit memo", "storno"]],
  [
    "receipt",
    [
      "zahlungsbestätigung",
      "zahlungsbestaetigung",
      "zahlungsbeleg",
      "zahlungsnachweis",
      "quittung",
      "kassenbeleg",
      "kassabeleg",
      "kaufbeleg",
      "payment confirmation",
      "confirmation of payment",
      "payment receipt",
      "receipt",
    ],
  ],
  ["invoice", ["rechnung", "invoice", "faktura", "honorarnote", "bill"]],
];

function isPresent(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Strip the punctuation a UID is printed with, so the country prefix is readable. */
function normalizeVatId(vatId: string | null | undefined): string {
  return (vatId ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Is a positive VAT rate printed anywhere the extraction looked — the
 * top-level field, the document's own rate-group block, or a line item?
 *
 * A printed 0% is deliberately NOT a rate here: zero is exactly what a
 * reverse-charge or exempt document shows, and it is the stated reason, not
 * the zero, that makes it lawful.
 */
function printedPositiveRates(facts: DocumentFacts): number[] {
  const rates: number[] = [];

  const collect = (value: unknown) => {
    const rate = toFiniteNumber(value);
    if (rate !== null && rate > 0) rates.push(rate);
  };

  collect(facts.vatPercent);
  for (const group of facts.rateGroups ?? []) collect(group?.rate);
  for (const item of facts.lineItems ?? []) collect(item?.vatPercent);

  return rates;
}

function hasPositiveRate(facts: DocumentFacts): boolean {
  return printedPositiveRates(facts).length > 0;
}

/**
 * Does the document STATE its rate as zero, rather than not state one at all?
 *
 * Two sources count, and line items deliberately do not. The top-level field
 * is what a human sets through the correction tool to record "the VAT on this
 * document must not be claimed" — a Kammerumlage assessment, an exempt
 * postal service. The printed rate-group block is transcribed off the
 * document, so a 0% row there means the document said so. Line items carry a
 * defaulted zero often enough that reading them here would invent a statement
 * the document never made.
 *
 * A stated zero satisfies § 11 Abs 6 Z 6: the Steuersatz is on the document.
 * It is not an excuse for anything else — an Austrian supplier billing a
 * zero-rated supply over 400 EUR still owes its UID.
 */
function statesZeroRate(facts: DocumentFacts): boolean {
  if (toFiniteNumber(facts.vatPercent) === 0) return true;
  return (facts.rateGroups ?? []).some((group) => toFiniteNumber(group?.rate) === 0);
}

/**
 * Does the document charge a rate Austria actually levies?
 *
 * This is what makes a missing supplier UID a real § 11 Abs 1 lit. i defect:
 * a supplier charging Austrian VAT is registered in Austria and owes a UID. A
 * supplier charging 21% or 25% is not, and holding lit. i against them would
 * be wrong in law and would fill the chase queue.
 */
function chargesAustrianRate(facts: DocumentFacts): boolean {
  return printedPositiveRates(facts).some((rate) => KNOWN_AUSTRIAN_RATES.includes(rate));
}

/** Why an absent Austrian rate is lawful, when the document says so. */
export function readZeroVatReason(facts: DocumentFacts): ZeroVatReason | null {
  const text = (facts.text ?? "").toLowerCase();

  if (text && REVERSE_CHARGE_MARKERS.some((marker) => text.includes(marker))) {
    return "reverse-charge";
  }
  if (text && EXEMPTION_MARKERS.some((marker) => text.includes(marker))) {
    return "exempt";
  }

  // No stated reason, but a supplier UID that is not Austrian is itself a
  // cross-border fact: the supply is taxed elsewhere or by the recipient.
  const vatId = normalizeVatId(facts.supplierVatId);
  if (/^[A-Z]{2}/.test(vatId) && !vatId.startsWith("AT")) {
    return "foreign-supplier";
  }

  // The supplier has no UID to print — a US or other third-country vendor —
  // but the document prints the RECIPIENT's Austrian UID. That is the
  // cross-border B2B shape: the supplier billed a business abroad and the
  // recipient self-assesses. A domestic till receipt never carries the
  // buyer's UID, so this cannot be mistaken for one.
  //
  // It also excuses an Austrian invoice whose supplier UID extraction simply
  // failed to read. That direction is the safe one: it leaves a real gap out
  // of the chase queue rather than putting phantom work into it.
  if (!isPresent(facts.supplierVatId) && normalizeVatId(facts.recipientVatId).startsWith("AT")) {
    return "cross-border-b2b";
  }

  return null;
}

/** What the document's own printed heading reads as. */
export function readSelfDesignationClass(
  selfDesignation: string | null | undefined
): SelfDesignationClass | null {
  if (!isPresent(selfDesignation)) return null;
  const heading = selfDesignation!.toLowerCase();

  for (const [designationClass, patterns] of DESIGNATION_PATTERNS) {
    if (patterns.some((pattern) => heading.includes(pattern))) return designationClass;
  }
  return null;
}

/**
 * What an absent Austrian VAT rate means on THIS document.
 *
 * The naive reading — no rate, therefore a receipt — is what would classify
 * a Hong Kong supplier's perfectly good invoice as a payment confirmation and
 * put it in the chase queue. A supply that is not taxed in Austria shows no
 * Austrian Steuersatz and often no UID either, and that is lawful.
 *
 *   "excused"       the document says why it carries none, or its supplier is
 *                   demonstrably not Austrian — the requirement does not apply
 *   "missing"       the absence can be held against it: an Austrian supplier
 *                   who must print a rate, a document that calls itself a
 *                   receipt, or one carrying no invoice identity at all
 *   "undecidable"   none of the above is knowable from this record. Guessing
 *                   here is what fills the queue with work that does not exist
 */
type SteuersatzVerdict = "present" | "excused" | "missing" | "undecidable";

function judgeSteuersatz(
  facts: DocumentFacts,
  zeroVatReason: ZeroVatReason | null,
  selfDesignationClass: SelfDesignationClass | null
): SteuersatzVerdict {
  if (hasPositiveRate(facts)) return "present";
  // The rate is stated and it is zero. That is a Steuersatz, not a gap — and
  // unlike an excuse it leaves every other § 11 element standing.
  if (zeroVatReason === "zero-rated") return "present";
  if (zeroVatReason) return "excused";

  // An Austrian supplier billing an Austrian supply must print the rate.
  if (normalizeVatId(facts.supplierVatId).startsWith("AT")) return "missing";

  // The document says what it is, and it is not an invoice.
  if (selfDesignationClass === "receipt") return "missing";

  // No rate, no UID, and extraction looked for an invoice number and found
  // none. A foreign invoice still carries a number; a till receipt does not.
  if (!isPresent(facts.supplierVatId) && facts.invoiceNumber === null) return "missing";

  return "undecidable";
}

/**
 * Elements § 11 requires at this amount that the record does not show.
 *
 * `undecidable` holds the ones this record cannot answer: the Steuersatz case
 * above, and the invoice number on every file extracted before #104 added the
 * field — where `undefined` must not be read as "the document printed none".
 */
function auditElements(
  facts: DocumentFacts,
  regime: Section11Regime,
  grossTotal: number,
  steuersatz: SteuersatzVerdict
): { missing: Section11Element[]; undecidable: Section11Element[] } {
  const missing: Section11Element[] = [];
  const undecidable: Section11Element[] = [];

  const require = (element: Section11Element, present: boolean) => {
    if (!present) missing.push(element);
  };

  require("issue-date", isPresent(facts.issueDate));
  require("supplier-name", isPresent(facts.supplierName));
  require("supplier-address", isPresent(facts.supplierAddress));
  require(
    "description",
    (facts.lineItems ?? []).some((item) => isPresent(item?.description))
  );

  // The rate is absent as a fact whenever it is not printed; whether that can
  // be held against the document is the separate question judged above.
  if (steuersatz !== "present" && steuersatz !== "excused") {
    missing.push("steuersatz");
    if (steuersatz === "undecidable") undecidable.push("steuersatz");
  }

  if (regime === "standard") {
    // § 11 Abs 1 lit. i binds a supplier registered in Austria. A missing UID
    // can only be held against a document that either charges an Austrian
    // rate or has already failed the Steuersatz test — a third-country
    // supplier has no UID to print, and demanding one would demote a perfectly
    // good invoice. Where neither is established the record cannot say.
    if (steuersatz !== "excused" && !isPresent(facts.supplierVatId)) {
      missing.push("supplier-vat-id");
      if (steuersatz !== "missing" && !chargesAustrianRate(facts)) {
        undecidable.push("supplier-vat-id");
      }
    }
    require("recipient", isPresent(facts.recipientName) && isPresent(facts.recipientAddress));

    if (facts.invoiceNumber === undefined) {
      missing.push("invoice-number");
      undecidable.push("invoice-number");
    } else if (!isPresent(facts.invoiceNumber)) {
      missing.push("invoice-number");
      // § 11 Abs 1 lit. h binds an Austrian invoice. Once the supply is
      // established as taxed outside Austria, a missing sequential number is
      // still worth reporting but cannot be held against the document — a US
      // vendor is not writing to the Austrian statute.
      if (steuersatz === "excused") undecidable.push("invoice-number");
    }

    if (grossTotal > RECIPIENT_VAT_ID_LIMIT_CENTS) {
      require("recipient-vat-id", isPresent(facts.recipientVatId));
    }
  }

  return { missing, undecidable };
}

function basis(
  reason: DocumentTypeReason,
  parts: Partial<DocumentTypeBasis> = {}
): DocumentTypeBasis {
  return {
    reason,
    regime: parts.regime ?? null,
    grossTotal: parts.grossTotal ?? null,
    selfDesignation: parts.selfDesignation ?? null,
    selfDesignationClass: parts.selfDesignationClass ?? null,
    zeroVatReason: parts.zeroVatReason ?? null,
    degraded: parts.degraded ?? false,
  };
}

/**
 * Classify one document from the facts extraction already produced.
 *
 * Degrades to `unknown` rather than guessing: a missing gross total picks no
 * regime, and a record that predates the fields which would decide it says so
 * instead of inventing a verdict. Both improve when the file is next
 * extracted, which is what makes the pending re-extraction sweep an
 * improvement rather than a precondition.
 */
export function classifyDocumentType(facts: DocumentFacts): DocumentTypeResult {
  const selfDesignation = isPresent(facts.selfDesignation) ? facts.selfDesignation!.trim() : null;
  const selfDesignationClass = readSelfDesignationClass(facts.selfDesignation);

  // The text classifier already ruled this out as a financial document; there
  // is nothing for § 11 to say about a tax form or a newsletter.
  if (facts.isNotInvoice === true) {
    return {
      type: "other",
      basis: basis("not-a-financial-document", { selfDesignation, selfDesignationClass }),
      missingElements: [],
    };
  }

  // The threshold decides which rule set applies, so without a total there is
  // no regime to apply and no honest verdict to give.
  const rawTotal = toFiniteNumber(facts.grossTotal);
  if (rawTotal === null || rawTotal === 0) {
    return {
      type: "unknown",
      basis: basis("no-gross-total", { selfDesignation, selfDesignationClass, degraded: true }),
      missingElements: [],
    };
  }

  const grossTotal = Math.abs(rawTotal);
  const regime: Section11Regime =
    grossTotal <= KLEINBETRAG_LIMIT_CENTS ? "kleinbetrag" : "standard";

  // Only consulted when no rate is printed: a document that shows 20% needs no
  // excuse, and reading one off its text could only misfire.
  // A stated reason outranks a bare zero: a reverse-charge invoice printing
  // "0%" is better described by the reverse charge than by the zero.
  const zeroVatReason = hasPositiveRate(facts)
    ? null
    : readZeroVatReason(facts) ?? (statesZeroRate(facts) ? "zero-rated" : null);
  const steuersatz = judgeSteuersatz(facts, zeroVatReason, selfDesignationClass);

  const { missing, undecidable } = auditElements(facts, regime, grossTotal, steuersatz);
  const decisive = DECISIVE_ELEMENTS[regime];
  const decisiveMissing = missing.filter(
    (element) => decisive.includes(element) && !undecidable.includes(element)
  );
  const decisiveUndecidable = undecidable.filter((element) => decisive.includes(element));

  const shared = { regime, grossTotal, selfDesignation, selfDesignationClass, zeroVatReason };

  if (decisiveMissing.length === 0 && decisiveUndecidable.length === 0) {
    return {
      type: "invoice",
      basis: basis(zeroVatReason ? "zero-vat-with-stated-regime" : "section-11-satisfied", shared),
      missingElements: missing,
    };
  }

  // Nothing can be held against the document — the record simply cannot
  // answer. Guessing here is what would put phantom work in the chase queue.
  if (decisiveMissing.length === 0) {
    return {
      type: "unknown",
      basis: basis("legacy-record-undecidable", { ...shared, degraded: true }),
      missingElements: missing,
    };
  }

  // From here the document is not a deductible invoice at its amount.

  // On a document the user ISSUED, that is a defect in their own invoicing,
  // not an invoice to chase from a supplier. Saying "receipt" here would put
  // the user's own outgoing paperwork in the chase queue.
  if (facts.isOutgoing === true) {
    return {
      type: "unknown",
      basis: basis("own-outgoing-document", shared),
      missingElements: missing,
    };
  }

  // Which kind of gap it is decides only the reason, never the type.
  let reason: DocumentTypeReason = "missing-decisive-elements";
  if (selfDesignationClass === "receipt") {
    reason = "receipt-designation";
  } else if (
    !hasPositiveRate(facts) &&
    !isPresent(facts.supplierVatId) &&
    facts.invoiceNumber === null
  ) {
    reason = "no-vat-no-invoice-identity";
  }

  return {
    type: "receipt",
    basis: basis(reason, shared),
    missingElements: missing,
  };
}
