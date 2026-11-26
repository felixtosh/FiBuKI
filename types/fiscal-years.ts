/**
 * What the browser reads about Fiscal Years from their callables (#794, #805,
 * ADR-0018). The server's own types live in functions/src/fiscalYears.
 */

/** A settings change that brings untracked rows in, as the server computed it. */
export interface UntrackedChoiceChange {
  trackedFrom: string;
  closedThrough?: string | null;
}

/** What previewUntrackedImport answers. */
export interface UntrackedImportPreview {
  untrackedCount: number;
  untrackedByFiscalYear: Record<string, number>;
  choices: { closed: UntrackedChoiceChange | null; open: UntrackedChoiceChange | null };
}

/** The preview's three answers. */
export type UntrackedChoice = "closed" | "open" | "skip";

/** What getUntrackedFilesHint answers: Files before Tracked From not yet seen, per fiscal year. */
export interface UntrackedFilesHint {
  count: number;
  byFiscalYear: Record<string, number>;
}
