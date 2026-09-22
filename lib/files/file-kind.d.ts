export interface FileKind {
  /** The normalised fileType — never empty, defaults to "application/octet-stream". */
  fileType: string;
  isPdf: boolean;
  isImage: boolean;
}

export function normalizeFileType(fileType: string | null | undefined): string;

export function classifyPreviewFile(
  fileType: string | null | undefined,
  fileName: string,
): FileKind;

export function previewFileExtensionLabel(
  fileType: string | null | undefined,
  fileName: string,
): string;

export function classifyFileStrict(fileType: string | null | undefined): FileKind;
