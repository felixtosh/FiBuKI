export function fileDeleteConfirmation(fileName: string): string;

export function bulkFileDeleteConfirmation(fileCount: number): string;

export function purgeConfirmation(
  fileCount: number,
  retentionRelevantCount: number,
): string;
