/**
 * Document type classification — pure data contracts (#104).
 *
 * A transaction can be fully matched, show green, and still be a bookkeeping
 * gap: Amazon and others send a payment confirmation (`Receipt`,
 * `Zahlungsbestätigung`, `Quittung`) that proves money moved but is not a
 * *Rechnung* under § 11 UStG and carries no right to Vorsteuer.
 *
 * These contracts are plain data in, verdict out. No Firestore handle, no
 * model call, no I/O — the same discipline as `uva/types.ts`, and for the
 * same reason: the rules must be testable exhaustively without fixtures.
 *
 * All amounts are integer cents.
 */

/**
 * What kind of document this is. A closed set of four.
 *
 * Reverse charge is deliberately NOT a fifth value: a reverse-charge document
 * is an invoice, and `transaction.isReverseCharge` (the UVA lane) already
 * carries that fact. The classifier's job is to avoid demoting it.
 */
export type DocumentType = "invoice" | "receipt" | "other" | "unknown";

/**
 * The § 11 elements this classifier can actually judge.
 *
 * Deliberately narrower than the statute. § 11 Abs 1 also requires the
 * delivery date or period (lit. d) and the quantity of each supply (lit. c),
 * which extraction does not produce as separate fields — testing for them
 * would report a defect on nearly every document and fill the chase queue
 * with work that does not exist.
 */
export type Section11Element =
  /** Ausstellungsdatum — Abs 6 Z 3 / Abs 1 lit. e */
  | "issue-date"
  /** Name des liefernden Unternehmers — Abs 6 Z 1 / Abs 1 lit. a */
  | "supplier-name"
  /** Anschrift des liefernden Unternehmers — Abs 6 Z 1 / Abs 1 lit. a */
  | "supplier-address"
  /** Handelsübliche Bezeichnung der Lieferung — Abs 6 Z 2 / Abs 1 lit. c */
  | "description"
  /** Steuersatz — Abs 6 Z 6 / the rate behind Abs 1 lit. g */
  | "steuersatz"
  /** Fortlaufende Nummer — Abs 1 lit. h, over 400 EUR only */
  | "invoice-number"
  /** UID des Lieferanten — Abs 1 lit. i, over 400 EUR only */
  | "supplier-vat-id"
  /** Name und Anschrift des Leistungsempfängers — Abs 1 lit. b, over 400 EUR only */
  | "recipient"
  /** UID des Leistungsempfängers — Abs 1 Z 2, over 10 000 EUR only */
  | "recipient-vat-id";

/** Which § 11 regime the document's gross total puts it in. */
export type Section11Regime = "kleinbetrag" | "standard";

/**
 * Why an absent Austrian VAT rate is lawful rather than a defect.
 *
 *   reverse-charge    the document states the § 19 wording
 *   exempt            the document states an exemption
 *   foreign-supplier  the supplier's UID is not Austrian
 *   cross-border-b2b  no supplier UID, but the document prints the
 *                     RECIPIENT's Austrian UID — the shape a supply taxed
 *                     outside Austria takes when the supplier has no UID
 *                     to print at all
 *   zero-rated        the rate IS stated, and it is zero — a printed 0% row,
 *                     or a human recording that the VAT is not claimable
 */
export type ZeroVatReason =
  | "reverse-charge"
  | "exempt"
  | "foreign-supplier"
  | "cross-border-b2b"
  | "zero-rated";

/** What the document's own printed heading reads as, when it is recognisable. */
export type SelfDesignationClass = "invoice" | "receipt" | "credit-note";

/** One-line machine-readable reason for the verdict. */
export type DocumentTypeReason =
  /** The text classifier already ruled this out as a financial document. */
  | "not-a-financial-document"
  /** No gross total, so no regime can be picked — see § 11 Abs 6's threshold. */
  | "no-gross-total"
  /** Every decisive element § 11 requires at this amount is present. */
  | "section-11-satisfied"
  /** No Austrian rate, but the document states why it carries none. */
  | "zero-vat-with-stated-regime"
  /** A decisive element is missing, and the document reads as a receipt. */
  | "receipt-designation"
  /** No rate, no invoice number, no supplier UID: a payment confirmation. */
  | "no-vat-no-invoice-identity"
  /** A decisive element § 11 requires at this amount is absent. */
  | "missing-decisive-elements"
  /** § 11 fails, but on a document the user issued rather than received. */
  | "own-outgoing-document"
  /** Only fields this record predates would decide it. */
  | "legacy-record-undecidable";

/**
 * Why the classifier decided what it did. Stored on the file next to the
 * type, so a borderline call can be judged instead of argued with.
 *
 * Every field is null rather than undefined: this object is written straight
 * into Firestore, which rejects undefined.
 */
export interface DocumentTypeBasis {
  reason: DocumentTypeReason;
  /** The regime the gross total selected, null when no total was known. */
  regime: Section11Regime | null;
  /** Gross total in cents that selected the regime, null when unknown. */
  grossTotal: number | null;
  /** The document's own printed heading, transcribed. Evidence, not verdict. */
  selfDesignation: string | null;
  /** What that heading reads as, when it is recognisable. */
  selfDesignationClass: SelfDesignationClass | null;
  /** Why an absent Austrian rate is lawful here, when it is. */
  zeroVatReason: ZeroVatReason | null;
  /**
   * True when a decisive element could not be judged because this record
   * predates the fields that decide it. Such a file classifies `unknown`
   * rather than guessing, and improves when it is next extracted.
   */
  degraded: boolean;
}

/** The classifier's verdict. */
export interface DocumentTypeResult {
  type: DocumentType;
  basis: DocumentTypeBasis;
  /**
   * Every § 11 element required at this amount that the record does not show
   * — the list a request to the supplier can name. Wider than the decisive
   * subset that drove `type`: extraction reports some elements unreliably,
   * so their absence is reported without demoting the document.
   */
  missingElements: Section11Element[];
}

/** One line item, as far as classification cares. */
export interface DocumentLineItemFacts {
  description?: string | null;
  vatPercent?: number | null;
}

/** One printed rate-group row, as far as classification cares. */
export interface DocumentRateGroupFacts {
  rate?: number | null;
}

/**
 * The facts extraction already produces, adapted for classification.
 *
 * Two fields carry a three-state meaning that the rest do not:
 * `selfDesignation` and `invoiceNumber`. `null` means extraction looked and
 * the document prints none. `undefined` means this record predates the field
 * — the classifier must not read that as absence.
 */
export interface DocumentFacts {
  /** Gross total, cents. Sign is ignored. null when the total is unknown. */
  grossTotal: number | null;
  /**
   * Document currency, ISO code. Recorded but not converted: the § 11
   * thresholds are EUR figures and the conversion basis is an unsettled
   * question (§ 20 Abs 6 UStG), deliberately out of scope here.
   */
  currency?: string | null;
  /** Top-level extracted VAT rate (0-100). */
  vatPercent?: number | null;
  /** Top-level extracted VAT amount, cents. */
  vatAmount?: number | null;
  /** The document's own printed per-rate VAT summary block. */
  rateGroups?: DocumentRateGroupFacts[] | null;
  lineItems?: DocumentLineItemFacts[] | null;
  supplierName?: string | null;
  supplierAddress?: string | null;
  supplierVatId?: string | null;
  recipientName?: string | null;
  recipientAddress?: string | null;
  recipientVatId?: string | null;
  /** Issue date, any non-empty string counts as present. */
  issueDate?: string | null;
  /** The printed heading. null = none printed; undefined = legacy record. */
  selfDesignation?: string | null;
  /** § 11 Abs 1 lit. h. null = none printed; undefined = legacy record. */
  invoiceNumber?: string | null;
  /** Full document text, scanned for a stated zero-VAT regime. */
  text?: string | null;
  /** The text classifier already said this is not a financial document. */
  isNotInvoice?: boolean;
  /**
   * The user issued this document rather than received it. A § 11 defect on
   * an outgoing document is a defect in the user's OWN invoicing, which is a
   * different problem and explicitly out of scope here — so it must not be
   * called a receipt and must not reach the chase queue.
   */
  isOutgoing?: boolean;
}

/**
 * How a transaction is documented. Additive to `isComplete`, which keeps its
 * current meaning of "has some documentation" — no line that is green today
 * turns red because of this field.
 */
export type DocumentationState =
  /** Holds at least one document that satisfies § 11 at its amount. */
  | "invoice"
  /** Holds documents, none of them a deductible invoice, at least one a receipt. */
  | "receipt-only"
  /** No documents; resolved by a no-receipt category. */
  | "no-receipt-category"
  /** Nothing at all. */
  | "undocumented"
  /** Holds documents whose type could not be established. */
  | "unknown";
