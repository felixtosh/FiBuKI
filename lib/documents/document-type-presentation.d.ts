import type {
  DirectionReviewReason,
  DocumentType,
  DocumentTypeBasis,
  Section11Element,
} from "@/types/file";
import type { InvoiceDirection } from "@/types/user-data";
import type { DocumentationState } from "@/types/transaction";

/**
 * A presentation-neutral name for how strongly a value reads. `unset` is its
 * own tone rather than a shade of `warning`: "not established" must not look
 * like a finding against the document.
 */
export type DocumentTone = "positive" | "warning" | "neutral" | "unset";

export interface DocumentTypePresentation {
  /** The resolved type — an absent field resolves to `unknown`. */
  type: DocumentType;
  /** English default for non-React callers. The UI renders `labelKey`. */
  label: string;
  /** Message-catalogue key for the interface locale; `label` is the English fallback. */
  labelKey?: string;
  tone: DocumentTone;
  /** One sentence on what the type means for the Vorsteuer. */
  summary: string;
}

export interface DocumentationStatePresentation {
  /** The resolved state — an absent field resolves to `unknown`, never to `undocumented`. */
  state: DocumentationState;
  /** German, as an Austrian EPU reads it: Rechnung, Nur Zahlungsbeleg, … */
  label: string;
  /** Message-catalogue key for the interface locale; `label` is the English fallback. */
  labelKey?: string;
  tone: DocumentTone;
  /** One sentence on what the state means for the Vorsteuer. */
  summary: string;
}

export interface Section11ElementPresentation {
  element: Section11Element | string;
  /** English interface label (ADR-0007). The UI renders `labelKey`. */
  label: string;
  /** Message-catalogue key; absent for an element this module cannot name. */
  labelKey?: string;
  /** The German statutory name: the supplier mail, and the bracket on first use. */
  german: string;
  /** The statute reference that makes the request answerable. */
  citation: string;
}

export interface MissingElementsPresentation {
  heading: string;
  tone: DocumentTone;
  note: string;
  /** Statute order, deduplicated. */
  items: Section11ElementPresentation[];
  /** German request text, or null when asking the supplier would be wrong. */
  requestText: string | null;
  /** True only when the absences are a defect to chase, not merely unprinted. */
  isDefect: boolean;
}

export interface BasisLine {
  id: "verdict" | "regime" | "heading" | "zero-vat" | "recipient" | "degraded";
  label: string;
  text: string;
}

export type BasisInput = DocumentTypeBasis;

export declare const KLEINBETRAG_LIMIT_CENTS: number;

export declare const DOCUMENT_TYPES: Record<
  DocumentType,
  Omit<DocumentTypePresentation, "type">
>;

export declare const DOCUMENTATION_STATES: Record<
  DocumentationState,
  Omit<DocumentationStatePresentation, "state">
>;

export declare const SECTION_11_ELEMENTS: Record<
  Section11Element,
  Omit<Section11ElementPresentation, "element">
>;

export declare const SECTION_11_ELEMENT_ORDER: Section11Element[];

export declare function describeDocumentType(
  type: DocumentType | null | undefined,
): DocumentTypePresentation;

export declare function describeDocumentationState(
  state: DocumentationState | null | undefined,
): DocumentationStatePresentation;

export declare function describeSection11Element(
  element: Section11Element | string,
): Section11ElementPresentation;

export declare function describeMissingElements(
  type: DocumentType | null | undefined,
  elements: Array<Section11Element | string> | null | undefined,
): MissingElementsPresentation;

export declare function describeDocumentTypeBasis(
  basis: BasisInput | null | undefined,
  type: DocumentType | null | undefined,
): BasisLine[];

/** The one at-rest sentence of the § 11 field: answer first, reason after (#237). */
export declare function describeSection11Consequence(
  type: DocumentType | null | undefined,
  basis: BasisInput | null | undefined,
): string;

/** A statutory term, glossed once and reused on every screen (#237). */
export interface TermGloss {
  /** The interface word, e.g. "Input VAT". */
  term: string;
  /** The German statutory word, or null when the term is itself a citation. */
  german: string | null;
  /** One or two sentences of vocabulary. Never a finding. */
  text: string;
}

export type TermGlossKey =
  | "vorsteuer"
  | "section11"
  | "kleinbetragsrechnung"
  | "steuersatz"
  | "uid"
  | "leistungsempfaenger"
  | "reverseCharge";

export declare const TERM_GLOSSES: Record<TermGlossKey, TermGloss>;

export declare function describeTerm(key: string): TermGloss | null;

export declare function buildSupplierRequestText(
  elements: Array<Section11Element | string> | null | undefined,
): string | null;

/** How an amount reads once the direction is known — or that it does not. */
export type DirectionSign = "negative" | "positive" | "unsigned";

export interface InvoiceDirectionPresentation {
  /** The resolved direction — anything unrecognised resolves to `unknown`. */
  direction: InvoiceDirection;
  /** German, as an Austrian EPU reads it: Eingangsrechnung, Ausgangsrechnung, … */
  label: string;
  tone: DocumentTone;
  summary: string;
  sign: DirectionSign;
}

export interface DirectionReviewPresentation {
  reason: DirectionReviewReason;
  label: string;
  tone: DocumentTone;
  text: string;
  /** What the linked transactions say it should be, when they agree. */
  suggestion: string | null;
  suggestedDirection: InvoiceDirection | null;
}

export interface RepairAmbiguityPresentation {
  label: string;
  tone: DocumentTone;
  /** Names the fields by the detail panel's labels, not response keys (#301). */
  text: string;
  /** The fields to look at, as response keys, so a caller can point at them directly. */
  fields: string[];
}

export interface RksvCodeReviewPresentation {
  tone: DocumentTone;
  /** Message keys; the words live in the catalogues. */
  labelKey: string;
  textKey: string;
  /** The rates at which the printed block and the code disagree. */
  rates: number[];
}

export interface ForeignRecipientPresentation {
  label: string;
  tone: DocumentTone;
  text: string;
}

export declare const INVOICE_DIRECTIONS: Record<
  InvoiceDirection,
  Omit<InvoiceDirectionPresentation, "direction">
>;

export declare function describeInvoiceDirection(
  direction: InvoiceDirection | string | null | undefined,
): InvoiceDirectionPresentation;

export declare function describeDirectionReview(
  review:
    | {
        needsDirectionReview?: boolean;
        directionReviewReason?: DirectionReviewReason | null;
        directionSuggested?: InvoiceDirection | null;
      }
    | null
    | undefined,
): DirectionReviewPresentation | null;

export declare function describeForeignRecipient(
  foreignRecipient: boolean | null | undefined,
): ForeignRecipientPresentation | null;

export declare function describeRepairAmbiguity(
  review:
    | {
        needsRepairReview?: boolean;
        repairAmbiguousFields?: string[] | null;
      }
    | null
    | undefined,
): RepairAmbiguityPresentation | null;

export declare function describeRksvCodeReview(
  review:
    | {
        needsRksvCodeReview?: boolean;
        rksvCodeDisagreeingRates?: number[] | null;
      }
    | null
    | undefined,
): RksvCodeReviewPresentation | null;
