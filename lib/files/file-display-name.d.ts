export interface FileDisplayNameInput {
  fileName: string;
  extractedInvoiceNumber?: string | null;
}

export interface FileProcessingInput {
  classificationComplete?: boolean;
  extractionComplete?: boolean;
  extractionError?: string | null;
  /** Any truthy value means a worker picked the File up (#603). */
  extractionStartedAt?: unknown;
  isNotInvoice?: boolean;
}

/** A key under `files.processing` in the messages. */
export type FileProcessingStatus =
  | "queued"
  | "analyzing"
  | "parsing"
  | "notInvoice"
  | "failed";

export type FileNameSecondLine =
  | { kind: "status"; status: FileProcessingStatus; busy: boolean }
  | { kind: "fileName"; text: string };

export interface FileNameCell {
  name: string;
  secondLine: FileNameSecondLine | null;
}

export function fileDisplayName(file: FileDisplayNameInput): string;

export function fileProcessingStatus(
  file: FileProcessingInput,
): { status: FileProcessingStatus; busy: boolean } | null;

export function describeFileNameCell(
  file: FileDisplayNameInput & FileProcessingInput,
): FileNameCell;
