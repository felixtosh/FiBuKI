/**
 * Tools that require user confirmation before execution
 *
 * Note: createPartner and assignPartnerToTransaction do NOT require confirmation
 * as they are low-risk and users typically want them executed immediately.
 *
 * Note: Download tools (downloadGmailAttachment, convertEmailToPdf) do NOT require
 * confirmation - the agent downloads when it finds a reasonable match.
 */
export const TOOLS_REQUIRING_CONFIRMATION = [
  "updateTransaction",
  "bulkUpdateTransactions",
  "createSource",
  "updateSource",
  "deleteSource",
  "rollbackTransaction",
] as const;

export type ConfirmableToolName = (typeof TOOLS_REQUIRING_CONFIRMATION)[number];

/**
 * Check if a tool requires confirmation
 */
export function requiresConfirmation(toolName: string): boolean {
  return TOOLS_REQUIRING_CONFIRMATION.includes(toolName as ConfirmableToolName);
}

/**
 * Impact level for confirmation UI styling
 */
export type ImpactLevel = "low" | "medium" | "high";

/**
 * Details for rendering a confirmation card
 */
export interface ConfirmationDetails {
  title: string;
  description: string;
  impact: ImpactLevel;
  previewData?: Record<string, unknown>;
}

/**
 * Get confirmation details for a tool call
 */
export function getConfirmationDetails(
  toolName: ConfirmableToolName,
  args?: Record<string, unknown>
): ConfirmationDetails {
  // Handle undefined args
  const safeArgs = args ?? {};

  switch (toolName) {
    case "updateTransaction":
      return {
        title: "Update Transaction",
        description: "This will update the transaction with the following changes:",
        impact: "low",
        previewData: filterUndefined({
          description: safeArgs.description,
          isComplete: safeArgs.isComplete,
        }),
      };

    case "bulkUpdateTransactions": {
      const ids = Array.isArray(safeArgs.transactionIds) ? safeArgs.transactionIds : [];
      return {
        title: "Bulk Update Transactions",
        description: `This will update ${ids.length} transaction(s) with the listed changes.`,
        impact: ids.length > 50 ? "high" : "medium",
        previewData: filterUndefined({
          count: ids.length,
          description: safeArgs.description,
          isComplete: safeArgs.isComplete,
          partnerId: safeArgs.partnerId,
          noReceiptCategoryId: safeArgs.noReceiptCategoryId,
          noReceiptCategoryTemplateId: safeArgs.noReceiptCategoryTemplateId,
          clearNoReceiptCategory: safeArgs.clearNoReceiptCategory,
        }),
      };
    }

    case "createSource":
      return {
        title: "Create Bank Account",
        description: "This will create a new bank account for importing transactions.",
        impact: "medium",
        previewData: filterUndefined({
          name: safeArgs.name,
          iban: safeArgs.iban,
          currency: safeArgs.currency,
        }),
      };

    case "updateSource":
      return {
        title: "Update Bank Account",
        description: "This will update the bank account details.",
        impact: "low",
        previewData: filterUndefined({
          name: safeArgs.name,
          bankName: safeArgs.bankName,
        }),
      };

    case "deleteSource":
      return {
        title: "Delete Bank Account",
        description:
          "This will mark the bank account as inactive. Associated transactions will remain but won't be visible in filters.",
        impact: "high",
        previewData: {
          sourceId: safeArgs.sourceId,
        },
      };

    case "rollbackTransaction":
      return {
        title: "Rollback Transaction",
        description:
          "This will restore the transaction to a previous state. A history entry will be created for this change.",
        impact: "medium",
        previewData: {
          transactionId: safeArgs.transactionId,
          historyId: safeArgs.historyId,
        },
      };

    default:
      return {
        title: "Confirm Action",
        description: "This action will modify data.",
        impact: "medium",
      };
  }
}

/**
 * Helper to filter out undefined values from an object
 */
function filterUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
