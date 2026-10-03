import { Timestamp } from "firebase/firestore";

/**
 * Record of a Cloud Function invocation for usage tracking.
 * Stored in the `functionCalls` Firestore collection.
 */
export interface FunctionCallRecord {
  id: string;
  functionName: CloudFunctionName;
  userId: string;
  status: "success" | "error";
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: Timestamp;
}

/**
 * All available Cloud Function names for type-safe callable invocations.
 * Add new function names here when creating new callables.
 */
export type CloudFunctionName =
  // Transaction operations
  | "updateTransaction"
  | "bulkUpdateTransactions"
  | "deleteTransactionsBySource"
  // Accepted Receipt (#165): rule a receipt-only line closed, or revoke.
  | "acceptReceiptOnly"
  // Accepted Partial Payment (#554): rule a tipped line's shortfall real, or revoke.
  | "acceptPartialPayment"
  // File operations
  | "createFile"
  | "updateFile"
  // The file detail panel's correction save (#149) — the UI half of the hand
  // correction the MCP tool makes through update_file_extraction.
  | "updateFileExtractedFields"
  | "deleteFile"
  | "restoreFile"
  | "purgeFiles"
  | "markFileAsNotInvoice"
  | "unmarkFileAsNotInvoice"
  | "markFileAsCopy"
  | "unmarkFileAsCopy"
  | "makeFileTheOriginal"
  | "backfillCopySuggestions"
  | "linkCorrection"
  | "unlinkCorrection"
  | "getCorrection"
  | "backfillCorrectionLinks"
  | "markUvaPeriodFiled"
  | "getUvaFiledStatus"
  | "connectFileToTransaction"
  | "disconnectFileFromTransaction"
  | "dismissTransactionSuggestion"
  // Exported by functions/src/index since fork #95 but never named here, so no
  // client could reach it through callFunction (which is keyed on this union).
  | "undismissTransactionSuggestion"
  | "unrejectFileFromTransaction"
  // Partner operations
  | "createUserPartner"
  | "updateUserPartner"
  | "deleteUserPartner"
  | "mergeUserPartners"
  | "assignPartnerToTransaction"
  | "removePartnerFromTransaction"
  | "setPartnerBillingCycle"
  // Source operations
  | "createSource"
  | "updateSource"
  | "deleteSource"
  | "getBalanceAtDate"
  | "getAccountBalances"
  // Import operations
  | "bulkCreateTransactions"
  | "createImportRecord"
  | "applyImportRemap"
  | "createDraftImport"
  | "updateDraftMappings"
  | "deleteDraftImport"
  | "deleteImportRecord"
  // Existing functions (already in codebase)
  | "matchColumns"
  | "matchPartners"
  | "catchUpPartnerMatching"
  | "learnPartnerPatterns"
  | "searchExternalPartners"
  | "matchCategories"
  | "searchGmailCallable"
  // Folder Integrations (ADR-0009)
  | "listFolderChoices"
  | "setFolderIntegrationFolder"
  | "updateFolderIntegrationSettings"
  | "syncFolderIntegration"
  | "disconnectFolderIntegration"
  | "generateSearchQueriesCallable"
  | "scoreAttachmentMatchCallable"
  | "findTransactionMatchesForFile"
  | "matchFilesForPartner"
  | "lookupCompany"
  | "lookupByVatId"
  | "retryFileExtraction"
  // User data export/import
  | "requestUserExport"
  | "validateUserImport"
  | "executeUserImport"
  // BMD export
  | "requestBmdExport"
  // Admin functions
  | "getAutomations"
  // Banking operations
  | "syncBankTransactions"
  | "cleanupOrphanedTransactions"
  | "createBankingConnection"
  | "initiateBankConnection"
  | "updateBankingConnection"
  | "deleteBankingConnection"
  | "createApiSource"
  | "updateSourceApiConfig"
  | "listBankInstitutions"
  // API key operations
  | "createApiKey"
  | "listApiKeys"
  | "revokeApiKey"
  // Billing operations
  | "createCheckoutSession"
  | "createPortalSession"
  | "updateOverageSettings"
  | "switchPlan"
  | "getPlanPricing"
  // Browser recipe operations
  | "saveBrowserRecipe"
  | "updateBrowserRecipe"
  | "deleteBrowserRecipe"
  | "migrateInvoiceSources"
  // Invoicing operations
  | "createInvoice"
  | "updateInvoice"
  | "issueInvoice"
  | "regenerateInvoicePdf"
  | "duplicateInvoice"
  | "cancelInvoice"
  | "undoIssueInvoice"
  | "deleteInvoice"
  | "createInvoiceShareLink"
  | "revokeInvoiceShareLink"
  | "listInvoices"
  | "getInvoice"
  // Card reconciliation operations
  | "confirmReconciliation"
  | "rejectReconciliation"
  // Investment operations
  | "bulkCreateTrades"
  | "matchInvestmentColumns"
  | "calculateFifo"
  | "calculateCapitalGainsSummary"
  | "activateInvestmentsAddon"
  | "deactivateInvestmentsAddon"
  | "activateBmdExportAddon"
  | "deactivateBmdExportAddon"
  | "activatePrioritySupportAddon"
  | "deactivatePrioritySupportAddon"
  // Automation mode
  | "updateAutomationMode"
  // Onboarding
  | "initOnboarding"
  | "syncOnboarding"
  | "updateOnboarding"
  // OAuth for connected apps
  | "createOAuthAuthorization"
  // Access requests
  | "submitAccessRequest"
  | "approveAccessRequest"
  | "dismissAccessRequest"
  // Country expansion
  | "backCountry"
  | "activateCountry"
  | "refundCountryBackers"
  | "seedCountryExpansion"
  // Referral operations
  | "getReferralCode"
  | "applyReferralCode"
  | "getReferralStats"
  // Digest / email preferences
  | "updateDigestPreference"
  | "updateEmailPreference"
  // UI language (#168)
  | "updateUserLocale"
  | "getTelegramLinkStatus"
  | "createTelegramLink"
  | "unlinkTelegram"
  // Password reset
  | "sendPasswordReset"
  // Open seats & invite emails
  | "setOpenSeats"
  | "getOpenSeats"
  | "sendInviteNotification"
  | "previewEmail"
  | "sendTestEmail";

/**
 * Summary statistics for function calls (for dashboards).
 */
export interface FunctionCallSummary {
  totalCalls: number;
  successCount: number;
  errorCount: number;
  avgDurationMs: number;
  byFunction: Record<
    string,
    {
      calls: number;
      successCount: number;
      errorCount: number;
      avgDurationMs: number;
    }
  >;
}

/**
 * Daily statistics for function calls.
 */
export interface FunctionCallDailyStats {
  date: string; // ISO date string (YYYY-MM-DD)
  calls: number;
  successCount: number;
  errorCount: number;
  avgDurationMs: number;
}
