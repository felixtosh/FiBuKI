import type {
  DocumentType,
  DocumentTypeBasis,
  Section11Element,
} from "@/types/file";
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
  /** German, as an Austrian EPU reads it: Rechnung, Zahlungsbeleg, … */
  label: string;
  tone: DocumentTone;
  /** One sentence on what the type means for the Vorsteuer. */
  summary: string;
}

export interface DocumentationStatePresentation {
  /** The resolved state — an absent field resolves to `unknown`, never to `undocumented`. */
  state: DocumentationState;
  /** German, as an Austrian EPU reads it: Rechnung, Nur Zahlungsbeleg, … */
  label: string;
  tone: DocumentTone;
  /** One sentence on what the state means for the Vorsteuer. */
  summary: string;
}

export interface Section11ElementPresentation {
  element: Section11Element | string;
  /** The element's German statutory name, for a mail to the supplier. */
  label: string;
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
  id: "verdict" | "regime" | "heading" | "zero-vat" | "degraded";
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

export declare function buildSupplierRequestText(
  elements: Array<Section11Element | string> | null | undefined,
): string | null;
