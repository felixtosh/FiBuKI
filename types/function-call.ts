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
  // File operations
  | "createFile"
  | "updateFile"
  | "deleteFile"
  | "restoreFile"
  | "markFileAsNotInvoice"
  | "unmarkFileAsNotInvoice"
  | "connectFileToTransaction"
  | "disconnectFileFromTransaction"
  | "dismissTransactionSuggestion"
  | "unrejectFileFromTransaction"
  // Partner operations
  | "createUserPartner"
  | "updateUserPartner"
  | "deleteUserPartner"
  | "assignPartnerToTransaction"
  | "removePartnerFromTransaction"
  // Source operations
  | "createSource"
  | "updateSource"
  | "deleteSource"
  | "getBalanceAtDate"
  | "getAccountBalances"
  // Import operations
  | "bulkCreateTransactions"
  | "createImportRecord"
  | "createDraftImport"
  | "updateDraftMappings"
  | "deleteDraftImport"
  | "deleteImportRecord"
  // Existing functions (already in codebase)
  | "matchColumns"
  | "matchPartners"
  | "learnPartnerPatterns"
  | "searchExternalPartners"
  | "matchCategories"
  | "searchGmailCallable"
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
  // Browser recipe operations
  | "saveBrowserRecipe"
  | "updateBrowserRecipe"
  | "deleteBrowserRecipe"
  | "migrateInvoiceSources"
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
  | "setOnboardingTrack"
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
  // Password reset
  | "sendPasswordReset"
  // Open seats & invite emails
  | "setOpenSeats"
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
