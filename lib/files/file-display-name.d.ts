export interface FileDisplayNameInput {
  fileName: string;
  extractedInvoiceNumber?: string | null;
}

export interface FileProcessingInput {
  classificationComplete?: boolean;
  extractionComplete?: boolean;
  isNotInvoice?: boolean;
}

export type FileNameSecondLine =
  | { kind: "status"; text: string; busy: boolean }
  | { kind: "fileName"; text: string };

export interface FileNameCell {
  name: string;
  secondLine: FileNameSecondLine | null;
}

export function fileDisplayName(file: FileDisplayNameInput): string;

export function fileProcessingStatus(
  file: FileProcessingInput,
): { text: string; busy: boolean } | null;

export function describeFileNameCell(
  file: FileDisplayNameInput & FileProcessingInput,
): FileNameCell;
