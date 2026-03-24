import { initializeApp } from "firebase-admin/app";

// Initialize Firebase Admin
initializeApp();

// Export partner matching functions
export { onPartnerCreate } from "./matching/onPartnerCreate";
export { onPartnerUpdate } from "./matching/onPartnerUpdate";
export { matchPartners } from "./matching/matchPartners";
export { learnPartnerPatterns } from "./matching/learnPartnerPatterns";
export { learnPartnerCategoryPatterns } from "./matching/learnPartnerCategoryPatterns";
export { searchExternalPartners } from "./matching/searchExternalPartners";
export { learnBillingCycleCallable as learnBillingCycle } from "./matching/learnBillingCycle";
export { learnScoringWeightsCallable as learnScoringWeights } from "./matching/learnScoringWeights";

// Export analytics functions
export { analyzeMatchAccuracyCallable as analyzeMatchAccuracy } from "./analytics/analyzeMatchAccuracy";
export { exportMatchIntelligenceCallable as exportMatchIntelligence } from "./analytics/exportMatchIntelligence";

// Export category matching functions
export { matchCategories } from "./matching/matchCategories";
export { onCategoryCreate } from "./matching/onCategoryCreate";
export { onCategoryUpdate } from "./matching/onCategoryUpdate";
export { onTransactionUpdate } from "./matching/onTransactionUpdate";

// Export user data update/create triggers (re-calculates file counterparties & syncs identity partners)
export { onUserDataUpdate, onUserDataCreated } from "./matching/onUserDataUpdate";

// Export learning queue functions
export {
  queuePartnerForLearning,
  processLearningQueue,
  triggerLearningNow,
} from "./matching/learningQueue";

// Export admin functions
export { generatePromotionCandidates } from "./admin/generatePromotionCandidates";
export { fixIsCompleteFlagCallable as fixIsCompleteFlag } from "./admin/fixIsCompleteFlag";
export {
  aggregateGlobalInsightsCallable as aggregateGlobalInsights,
  scheduledAggregateGlobalInsights,
} from "./admin/aggregateGlobalInsights";
export {
  listAllUsers,
  setUserOverride,
  switchTesterPlan,
  adminDeleteUser,
} from "./admin/userManagement";

// Export import functions
export { matchColumns } from "./import/matchColumns";

// Export file extraction functions
export { extractFileData, extractFileDataOnUndelete } from "./extraction/extractFileData";
export { retryFileExtraction } from "./extraction/retryExtraction";

// Export file-partner matching functions
export { matchFilePartner } from "./matching/matchFilePartner";

// Export file-transaction matching functions
export { matchFileTransactions } from "./matching/matchFileTransactions";
export { findTransactionMatchesForFile } from "./matching/findTransactionMatches";
export { matchFilesForPartner } from "./matching/matchFilesForPartner";

// Export orphaned file processing (fallback for stuck files)
export { processOrphanedFiles } from "./matching/processOrphanedFiles";

// Export AI helper functions
export { generateFileSearchQuery } from "./ai/generateFileSearchQuery";
export { lookupCompany, lookupByVatId } from "./ai/lookupCompany";

// Export Gmail sync functions
export {
  processGmailSyncQueue,
  onSyncQueueCreated,
} from "./gmail/gmailSyncQueue";
export { scheduledGmailSync } from "./gmail/scheduledGmailSync";
export { onMailServiceConnected, onMailServiceReconnected } from "./gmail/onMailServiceConnected";
export { onTransactionsImported } from "./gmail/onTransactionsImported";
export { onTransactionsImportedCompanyCheck } from "./matching/onTransactionsImportedCompanyCheck";
export { searchGmailCallable } from "./gmail/searchGmailCallable";

// Export precision search functions
export {
  processPrecisionSearchQueue,
  onPrecisionSearchQueueCreated,
} from "./precision-search/precisionSearchQueue";
export { onGmailSyncComplete } from "./precision-search/onGmailSyncComplete";
export { generateSearchQueriesCallable } from "./precision-search/generateSearchQueriesCallable";
export { scoreAttachmentMatchCallable } from "./precision-search/scoreAttachmentMatchCallable";
export { convertHtmlToPdfCallable } from "./precision-search/convertHtmlToPdfCallable";

// Export inbound email functions
export { receiveInboundEmail, testInboundEmail } from "./email-inbound/receiveEmail";
export { resetInboundDailyLimits } from "./email-inbound/resetDailyLimits";

// Export auth functions
export {
  setAdminClaim,
  listAdmins,
} from "./auth/setAdminClaim";
export { validateRegistration, markInviteUsed } from "./auth/validateRegistration";
export { submitAccessRequest, approveAccessRequest, dismissAccessRequest } from "./auth/accessRequests";
export { setOpenSeatsCallable as setOpenSeats } from "./auth/openSeats";
export { sendInviteNotificationCallable as sendInviteNotification } from "./auth/sendInviteNotificationCallable";
export { previewEmailCallable as previewEmail } from "./auth/previewEmail";
export { sendTestEmailCallable as sendTestEmail } from "./auth/sendTestEmail";
export { migrateUserData, checkMigrationStatus } from "./auth/migrateUserData";

// Export MFA functions
export {
  generateBackupCodes,
  verifyBackupCode,
  getMfaStatus,
  recordMfaSuccess,
  adminResetMfa,
  generatePasskeyRegistrationOptions,
  verifyPasskeyRegistration,
  generatePasskeyAuthOptions,
  verifyPasskeyAuth,
  deletePasskey,
  updateTotpStatus,
  setUserPassword,
} from "./auth/mfaFunctions";

// ============================================================================
// DATA OPERATIONS - All mutations go through Cloud Functions
// ============================================================================

// Transaction operations
export {
  updateTransactionCallable as updateTransaction,
  bulkUpdateTransactionsCallable as bulkUpdateTransactions,
  deleteTransactionsBySourceCallable as deleteTransactionsBySource,
} from "./transactions";

// File operations
export {
  createFileCallable as createFile,
  updateFileCallable as updateFile,
  deleteFileCallable as deleteFile,
  restoreFileCallable as restoreFile,
  markFileAsNotInvoiceCallable as markFileAsNotInvoice,
  unmarkFileAsNotInvoiceCallable as unmarkFileAsNotInvoice,
  connectFileToTransactionCallable as connectFileToTransaction,
  disconnectFileFromTransactionCallable as disconnectFileFromTransaction,
  dismissTransactionSuggestionCallable as dismissTransactionSuggestion,
  unrejectFileFromTransactionCallable as unrejectFileFromTransaction,
} from "./files";

// Import operations
export {
  bulkCreateTransactionsCallable as bulkCreateTransactions,
  createImportRecordCallable as createImportRecord,
  createDraftImportCallable as createDraftImport,
  updateDraftMappingsCallable as updateDraftMappings,
  deleteDraftImportCallable as deleteDraftImport,
  deleteImportRecordCallable as deleteImportRecord,
  cleanupExpiredDrafts,
} from "./imports";

// Partner operations
export {
  createUserPartnerCallable as createUserPartner,
  updateUserPartnerCallable as updateUserPartner,
  deleteUserPartnerCallable as deleteUserPartner,
  assignPartnerToTransactionCallable as assignPartnerToTransaction,
  removePartnerFromTransactionCallable as removePartnerFromTransaction,
} from "./partners";

// Source operations
export {
  createSourceCallable as createSource,
  updateSourceCallable as updateSource,
  deleteSourceCallable as deleteSource,
  getBalanceAtDateCallable as getBalanceAtDate,
  getAccountBalancesCallable as getAccountBalances,
  backfillSourcePartnersCallable as backfillSourcePartners,
} from "./sources";

// Worker operations
export { triggerFileMatchingWorkerCallable as triggerFileMatchingWorker } from "./workers/triggerFileMatchingWorker";
export { runReceiptSearchForTransactionCallable as runReceiptSearchForTransaction } from "./workers/runReceiptSearchForTransaction";

// Report operations
export {
  generateUvaXmlCallable as generateUvaXml,
  generateUvaPdfCallable as generateUvaPdf,
} from "./reports";

// Automation registry (for admin page)
export { getAutomationsCallable as getAutomations } from "./automation";

// User data export operations
export {
  requestUserExportCallable as requestUserExport,
  processUserExportOnCreate,
  processUserExportScheduled,
  cleanupExpiredExports,
} from "./user-export";

// User data import operations
export {
  validateUserImportCallable as validateUserImport,
  executeUserImportCallable as executeUserImport,
  processUserImportOnUpdate,
} from "./user-import";

// User account operations
export { deleteUserAccountCallable as deleteUserAccount } from "./user/deleteUserAccountCallable";
export { scheduleAccountDeletionCallable as scheduleAccountDeletion } from "./user/scheduleAccountDeletionCallable";
export { cancelAccountDeletionCallable as cancelAccountDeletion } from "./user/cancelAccountDeletionCallable";
export { processPendingDeletions } from "./user/processPendingDeletions";

// BMD NTCS export operations
export {
  requestBmdExportCallable as requestBmdExport,
  processBmdExportOnCreate,
} from "./bmd-export";

// FinanzOnline WebService operations
export {
  saveFinanzOnlineCredentialsCallable as saveFinanzOnlineCredentials,
  testFinanzOnlineConnectionCallable as testFinanzOnlineConnection,
  deleteFinanzOnlineCredentialsCallable as deleteFinanzOnlineCredentials,
} from "./finanzonline/credentialCallables";
export { submitUvaToFinanzOnlineCallable as submitUvaToFinanzOnline } from "./finanzonline/submitUvaCallable";

// finAPI banking integration (legacy - use syncBankTransactions instead)
export { syncFinapiTransactions } from "./finapi/syncCallable";

// Banking operations (new - with orphan handling and full deduplication)
export {
  syncBankTransactionsCallable as syncBankTransactions,
  cleanupOrphanedTransactionsCallable as cleanupOrphanedTransactions,
  createBankingConnectionCallable as createBankingConnection,
  initiateBankConnectionCallable as initiateBankConnection,
  updateBankingConnectionCallable as updateBankingConnection,
  deleteBankingConnectionCallable as deleteBankingConnection,
  createApiSourceCallable as createApiSource,
  updateSourceApiConfigCallable as updateSourceApiConfig,
  listBankInstitutionsCallable as listBankInstitutions,
} from "./banking";

// API key management (for external integrations)
export {
  createApiKeyCallable as createApiKey,
  listApiKeysCallable as listApiKeys,
  revokeApiKeyCallable as revokeApiKey,
} from "./api-keys";

// Billing operations
export {
  createCheckoutSessionCallable as createCheckoutSession,
  createPortalSessionCallable as createPortalSession,
  addAICreditsCallable as addAICredits,
  updateOverageSettingsCallable as updateOverageSettings,
  switchPlanCallable as switchPlan,
  stripeWebhook,
} from "./billing";
export { updateAutomationModeCallable as updateAutomationMode } from "./billing/updateAutomationMode";

// Browser recipe operations
export { saveBrowserRecipeCallable as saveBrowserRecipe } from "./browser/saveBrowserRecipe";
export { updateBrowserRecipeCallable as updateBrowserRecipe } from "./browser/updateBrowserRecipe";
export { deleteBrowserRecipeCallable as deleteBrowserRecipe } from "./browser/deleteBrowserRecipe";
export { migrateInvoiceSourcesCallable as migrateInvoiceSources } from "./browser/migrateInvoiceSources";

// Card reconciliation operations (processReconciliation is now a utility called from onTransactionUpdate)
export {
  confirmReconciliationCallable as confirmReconciliation,
} from "./reconciliation/confirmReconciliation";
export {
  rejectReconciliationCallable as rejectReconciliation,
} from "./reconciliation/rejectReconciliation";

// Investment operations
export {
  bulkCreateTradesCallable as bulkCreateTrades,
  matchInvestmentColumns,
  calculateFifoCallable as calculateFifo,
  calculateCapitalGainsSummaryCallable as calculateCapitalGainsSummary,
} from "./investments";

// Billing addon operations
export {
  activateInvestmentsAddonCallable as activateInvestmentsAddon,
  deactivateInvestmentsAddonCallable as deactivateInvestmentsAddon,
} from "./billing/investmentsAddon";

// Onboarding operations
export { setOnboardingTrackCallable as setOnboardingTrack } from "./onboarding/setOnboardingTrackCallable";

// Country expansion operations
export {
  backCountryCallable as backCountry,
  activateCountryCallable as activateCountry,
  refundCountryBackersCallable as refundCountryBackers,
  seedCountryExpansionCallable as seedCountryExpansion,
} from "./expand";

// Referral operations
export {
  getReferralCodeCallable as getReferralCode,
  applyReferralCodeCallable as applyReferralCode,
  getReferralStatsCallable as getReferralStats,
} from "./referral";

// Digest email operations
export {
  sendWeeklyDigest,
  unsubscribeDigest,
  updateDigestPreferenceCallable as updateDigestPreference,
  updateEmailPreferenceCallable as updateEmailPreference,
} from "./digest";

// Budget warning unsubscribe
export { unsubscribeBudgetWarnings } from "./billing/unsubscribeBudgetWarnings";

// Custom password reset email
export { sendPasswordResetCallable as sendPasswordReset } from "./auth/sendPasswordResetCallable";

// MCP HTTP API (for OpenClaw, Claude Desktop, ChatGPT, etc.)
export { mcpApi, mcpToolsList, mcpSse } from "./mcp-api";
export { openApiSpec, aiPluginManifest } from "./mcp-api/openapi";
