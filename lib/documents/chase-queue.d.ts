import type { Transaction, DocumentationState } from "@/types/transaction";
import type { Section11Element, TaxFile } from "@/types/file";

/** Only the slice of a transaction the queue reads. */
export type ChaseQueueTransaction = Pick<Transaction, "id" | "amount"> &
  Partial<
    Pick<
      Transaction,
      | "date"
      | "currency"
      | "name"
      | "partner"
      | "partnerId"
      | "fileIds"
      | "documentationState"
    >
  >;

/** Only the slice of a file the queue reads. */
export type ChaseQueueFile = Pick<TaxFile, "id"> &
  Partial<
    Pick<
      TaxFile,
      "fileName" | "documentType" | "documentTypeBasis" | "documentTypeMissingElements"
    >
  >;

export interface ChaseQueueDocument {
  fileId: string;
  fileName: string | null;
  documentType: TaxFile["documentType"] | null;
  /** The § 11 elements this document does not show. */
  missingElements: Array<Section11Element | string>;
  basisReason: string | null;
}

export interface ChaseQueueRow {
  id: string;
  /** Resolved from whatever shape the record stores its date in. */
  date: Date | null;
  /** Signed cents, as the bank stated it. */
  amount: number;
  currency: string;
  name: string | null;
  partner: string | null;
  partnerId: string | null;
  /** The counterparty as the row can best name it, before partner lookup. */
  vendor: string | null;
  documentationState: DocumentationState | null;
  /** Union across the attached documents, deduplicated. */
  missingElements: Array<Section11Element | string>;
  documents: ChaseQueueDocument[];
}

export interface ChaseQueueOptions {
  /** Minimum ABSOLUTE amount in cents — the same filter the agent tool takes. */
  minAmount?: number | null;
  /** Default `amount`: the deductions worth chasing come first. */
  sort?: "amount" | "date";
}

export interface ChaseQueueResult {
  rows: ChaseQueueRow[];
  /** Receipt-only transactions BEFORE the amount filter. */
  totalCount: number;
  /**
   * Sum of the absolute amounts of the rows shown, in cents. Meaningful only
   * when `currencies` holds exactly one code — nothing here converts.
   */
  totalAmount: number;
  /** The distinct currencies of the rows shown, sorted. */
  currencies: string[];
}

export declare const CHASEABLE_STATE: DocumentationState;

export declare function buildChaseQueue(
  transactions: ChaseQueueTransaction[],
  files: ChaseQueueFile[],
  options?: ChaseQueueOptions,
): ChaseQueueResult;

export declare function countChaseQueue(
  transactions: Array<Pick<Transaction, "id"> & { documentationState?: DocumentationState }>,
): number;
