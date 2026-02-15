/**
 * Design System - Tool Result Components
 *
 * Consolidated GenUI components for rendering tool call results
 * in the chat interface. Import from this index for all tool result previews.
 *
 * @example
 * import {
 *   LocalFilesResult,
 *   GmailAttachmentsResult,
 *   TransactionListResult,
 * } from "@/design-system/tool-results";
 */

// Types
export type {
  SearchedTransactionContext,
  LocalFileCandidate,
  GmailAttachmentCandidate,
  GmailEmailCandidate,
  LocalFilesSearchResult,
  GmailAttachmentsSearchResult,
  GmailEmailsSearchResult,
  SearchSuggestion,
  SearchSuggestionsResultData,
  TransactionResult,
  FileResult,
  FileListResult as FileListResultType,
  ToolResultUIActions,
  // Partner types
  PartnerResult,
  PartnerListResult as PartnerListResultType,
  CompanyLookupResult,
  VatValidationResult,
} from "./types";

// Components
export { LocalFilesResult } from "./local-files-result";
export { GmailAttachmentsResult } from "./gmail-attachments-result";
export { GmailEmailsResult } from "./gmail-emails-result";
export { SearchSuggestionsResult } from "./search-suggestions-result";
export { TransactionListResult } from "./transaction-list-result";
export { FileListResult } from "./file-list-result";
export {
  PartnerListResult,
  CompanyLookupResultUI,
  VatValidationResultUI,
} from "./partner-results";
export { ToolStepList } from "./tool-step-list";
