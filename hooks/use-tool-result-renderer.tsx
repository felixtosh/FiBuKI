"use client";

import { ReactNode, useCallback, useMemo } from "react";
import {
  LocalFilesResult,
  GmailAttachmentsResult,
  GmailEmailsResult,
  SearchSuggestionsResult,
  TransactionListResult,
  FileListResult,
  PartnerListResult,
  CompanyLookupResultUI,
  VatValidationResultUI,
  LocalFilesSearchResult,
  GmailAttachmentsSearchResult,
  GmailEmailsSearchResult,
  SearchSuggestionsResultData,
  TransactionResult,
  FileResult,
  ToolResultUIActions,
  PartnerResult,
  CompanyLookupResult,
  VatValidationResult,
} from "@/design-system/tool-results";
import { fileResultFromRecord } from "@/design-system/tool-results/file-result-from-record";
import { ToolCall } from "@/types/chat";

/**
 * Registry of tool result renderers.
 * Maps tool names to their result component renderers.
 */
type ToolResultRenderer = (
  result: unknown,
  uiActions?: ToolResultUIActions,
  toolArgs?: Record<string, unknown>
) => ReactNode | null;

interface UseToolResultRendererOptions {
  uiActions?: ToolResultUIActions;
}

/**
 * Hook for rendering tool call results using the design system components.
 *
 * @example
 * ```tsx
 * const { renderToolResult, hasRenderer } = useToolResultRenderer({
 *   uiActions: {
 *     scrollToTransaction: (id) => ...,
 *     openTransactionSheet: (id) => ...,
 *   }
 * });
 *
 * if (hasRenderer(toolCall.name)) {
 *   return renderToolResult(toolCall);
 * }
 * ```
 */
export function useToolResultRenderer(options: UseToolResultRendererOptions = {}) {
  const { uiActions } = options;

  /**
   * Registry of all supported tool result renderers.
   * Add new tool renderers here when adding new GenUI components.
   */
  const renderers = useMemo<Record<string, ToolResultRenderer>>(() => ({
    // Transaction list
    listTransactions: (result, actions, toolArgs) => {
      // Handle both formats: {transactions: [...], total: N} or direct array
      let transactions: TransactionResult[];
      let totalCount: number | undefined;
      if (Array.isArray(result)) {
        transactions = result;
      } else if (result && typeof result === "object" && "transactions" in result) {
        const typedResult = result as { transactions: TransactionResult[]; total?: number };
        transactions = typedResult.transactions;
        totalCount = typedResult.total;
      } else {
        return null;
      }
      if (!Array.isArray(transactions) || transactions.length === 0) return null;

      // Extract search query from tool args if available
      const searchQuery = toolArgs?.search as string | undefined;

      return (
        <TransactionListResult
          transactions={transactions}
          uiActions={actions}
          searchQuery={searchQuery}
          totalCount={totalCount}
        />
      );
    },

    // Local files search
    searchLocalFiles: (result, actions) => {
      const typedResult = result as LocalFilesSearchResult;
      if (typedResult?.searchType !== "local_files") return null;
      return (
        <LocalFilesResult
          result={typedResult}
          uiActions={actions}
        />
      );
    },

    // Gmail attachments search
    searchGmailAttachments: (result, actions) => {
      const typedResult = result as GmailAttachmentsSearchResult;
      if (typedResult?.searchType !== "gmail_attachments") return null;
      return (
        <GmailAttachmentsResult
          result={typedResult}
          uiActions={actions}
        />
      );
    },

    // Gmail emails search (mail invoices / invoice links)
    searchGmailEmails: (result) => {
      const typedResult = result as GmailEmailsSearchResult;
      if (typedResult?.searchType !== "gmail_emails") return null;
      return (
        <GmailEmailsResult
          result={typedResult}
        />
      );
    },

    // Search suggestions
    generateSearchSuggestions: (result) => {
      const typedResult = result as SearchSuggestionsResultData;
      // Add searchType for validation
      if (!typedResult?.suggestions && !typedResult?.queries) return null;
      return (
        <SearchSuggestionsResult
          result={{ ...typedResult, searchType: "search_suggestions" }}
        />
      );
    },

    // List files
    listFiles: (result, actions, toolArgs) => {
      // Handle both formats: {files: [...], total: N} or direct array
      let files: FileResult[];
      let totalCount: number | undefined;
      if (Array.isArray(result)) {
        files = result;
      } else if (result && typeof result === "object" && "files" in result) {
        const typedResult = result as { files: FileResult[]; total?: number };
        files = typedResult.files;
        totalCount = typedResult.total;
      } else {
        return null;
      }
      if (!Array.isArray(files) || files.length === 0) return null;

      // Extract search query from tool args if available
      const searchQuery = toolArgs?.search as string | undefined;

      return (
        <FileListResult
          files={files.map((f) => fileResultFromRecord(f as unknown as Record<string, unknown>))}
          uiActions={actions}
          searchQuery={searchQuery}
          totalCount={totalCount}
        />
      );
    },

    // List partners
    listPartners: (result, _actions, toolArgs) => {
      // Handle both formats: {partners: [...], total: N} or direct array
      let partners: PartnerResult[];
      let totalCount: number | undefined;
      if (Array.isArray(result)) {
        partners = result;
      } else if (result && typeof result === "object" && "partners" in result) {
        const typedResult = result as { partners: PartnerResult[]; total?: number };
        partners = typedResult.partners;
        totalCount = typedResult.total;
      } else {
        return null;
      }

      // Extract search query from tool args if available
      const searchQuery = toolArgs?.search as string | undefined;

      return (
        <PartnerListResult
          partners={partners}
          searchQuery={searchQuery}
          totalCount={totalCount}
        />
      );
    },

    // Company lookup
    lookupCompanyInfo: (result) => {
      const typedResult = result as CompanyLookupResult;
      if (!typedResult || typeof typedResult !== "object") return null;
      // Must have searchTerm to be a valid result
      if (!("searchTerm" in typedResult)) return null;
      return <CompanyLookupResultUI result={typedResult} />;
    },

    // VAT validation
    validateVatId: (result) => {
      const typedResult = result as VatValidationResult;
      if (!typedResult || typeof typedResult !== "object") return null;
      // Must have vatId to be a valid result
      if (!("vatId" in typedResult)) return null;
      return <VatValidationResultUI result={typedResult} />;
    },
  }), []);

  /**
   * Check if a tool has a registered result renderer.
   */
  const hasRenderer = useCallback(
    (toolName: string): boolean => {
      return toolName in renderers;
    },
    [renderers]
  );

  /**
   * Get list of all supported tool names with renderers.
   */
  const supportedTools = useMemo(() => Object.keys(renderers), [renderers]);

  /**
   * Render a tool call's result using the appropriate GenUI component.
   * Returns null if no renderer is registered or if result is empty.
   */
  const renderToolResult = useCallback(
    (toolCall: ToolCall): ReactNode | null => {
      if (toolCall.status !== "executed" || !toolCall.result) {
        return null;
      }

      const renderer = renderers[toolCall.name];
      if (!renderer) {
        return null;
      }

      return renderer(toolCall.result, uiActions, toolCall.args);
    },
    [renderers, uiActions]
  );

  /**
   * Render a result directly by tool name (without a ToolCall wrapper).
   * Useful for previewing results or testing.
   */
  const renderResult = useCallback(
    (toolName: string, result: unknown): ReactNode | null => {
      const renderer = renderers[toolName];
      if (!renderer) {
        return null;
      }
      return renderer(result, uiActions);
    },
    [renderers, uiActions]
  );

  return {
    renderToolResult,
    renderResult,
    hasRenderer,
    supportedTools,
  };
}
