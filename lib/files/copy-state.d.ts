export interface CopyStateFile {
  id: string;
  copyOfFileId?: string | null;
  deletedAt?: unknown;
  purgedAt?: unknown;
}

export interface CopySuggestionLike {
  originalFileId: string;
  reason: string;
}

export function liveCopies(files: readonly CopyStateFile[]): Map<string, string>;

export function liveCopySuggestion<S extends CopySuggestionLike>(
  file: { copySuggestion?: S | null },
  byId: Map<string, { deletedAt?: unknown; purgedAt?: unknown }>,
): S | null;
