"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateSearchQueriesCallable = exports.onGmailSyncComplete = exports.onPrecisionSearchQueueCreated = exports.processPrecisionSearchQueue = exports.searchGmailCallable = exports.onTransactionsImportedCompanyCheck = exports.onTransactionsImported = exports.onMailServiceReconnected = exports.onMailServiceConnected = exports.scheduledGmailSync = exports.onSyncQueueCreated = exports.processGmailSyncQueue = exports.lookupByVatId = exports.lookupCompany = exports.generateFileSearchQuery = exports.processOrphanedFiles = exports.matchFilesForPartner = exports.findTransactionMatchesForFile = exports.matchFileTransactions = exports.matchFilePartner = exports.retryFileExtraction = exports.extractFileDataOnUndelete = exports.extractFileData = exports.matchColumns = exports.switchTesterPlan = exports.setUserOverride = exports.listAllUsers = exports.scheduledAggregateGlobalInsights = exports.aggregateGlobalInsights = exports.fixIsCompleteFlag = exports.generatePromotionCandidates = exports.triggerLearningNow = exports.processLearningQueue = exports.queuePartnerForLearning = exports.onUserDataCreated = exports.onUserDataUpdate = exports.onTransactionUpdate = exports.onCategoryUpdate = exports.onCategoryCreate = exports.matchCategories = exports.exportMatchIntelligence = exports.analyzeMatchAccuracy = exports.learnScoringWeights = exports.learnBillingCycle = exports.searchExternalPartners = exports.learnPartnerCategoryPatterns = exports.learnPartnerPatterns = exports.matchPartners = exports.onPartnerUpdate = exports.onPartnerCreate = void 0;
exports.deleteUserPartner = exports.updateUserPartner = exports.createUserPartner = exports.cleanupExpiredDrafts = exports.deleteImportRecord = exports.deleteDraftImport = exports.updateDraftMappings = exports.createDraftImport = exports.createImportRecord = exports.bulkCreateTransactions = exports.unrejectFileFromTransaction = exports.dismissTransactionSuggestion = exports.disconnectFileFromTransaction = exports.connectFileToTransaction = exports.unmarkFileAsNotInvoice = exports.markFileAsNotInvoice = exports.restoreFile = exports.deleteFile = exports.updateFile = exports.createFile = exports.deleteTransactionsBySource = exports.bulkUpdateTransactions = exports.updateTransaction = exports.setUserPassword = exports.updateTotpStatus = exports.deletePasskey = exports.verifyPasskeyAuth = exports.generatePasskeyAuthOptions = exports.verifyPasskeyRegistration = exports.generatePasskeyRegistrationOptions = exports.adminResetMfa = exports.recordMfaSuccess = exports.getMfaStatus = exports.verifyBackupCode = exports.generateBackupCodes = exports.checkMigrationStatus = exports.migrateUserData = exports.dismissAccessRequest = exports.approveAccessRequest = exports.submitAccessRequest = exports.markInviteUsed = exports.validateRegistration = exports.listAdmins = exports.beforeUserCreatedHandler = exports.setAdminClaim = exports.resetInboundDailyLimits = exports.testInboundEmail = exports.receiveInboundEmail = exports.convertHtmlToPdfCallable = exports.scoreAttachmentMatchCallable = void 0;
exports.saveBrowserRecipe = exports.updateAutomationMode = exports.stripeWebhook = exports.updateOverageSettings = exports.addAICredits = exports.createPortalSession = exports.createCheckoutSession = exports.revokeApiKey = exports.listApiKeys = exports.createApiKey = exports.listBankInstitutions = exports.updateSourceApiConfig = exports.createApiSource = exports.deleteBankingConnection = exports.updateBankingConnection = exports.initiateBankConnection = exports.createBankingConnection = exports.cleanupOrphanedTransactions = exports.syncBankTransactions = exports.syncFinapiTransactions = exports.submitUvaToFinanzOnline = exports.deleteFinanzOnlineCredentials = exports.testFinanzOnlineConnection = exports.saveFinanzOnlineCredentials = exports.processBmdExportOnCreate = exports.requestBmdExport = exports.processPendingDeletions = exports.cancelAccountDeletion = exports.scheduleAccountDeletion = exports.deleteUserAccount = exports.processUserImportOnUpdate = exports.executeUserImport = exports.validateUserImport = exports.cleanupExpiredExports = exports.processUserExportScheduled = exports.processUserExportOnCreate = exports.requestUserExport = exports.getAutomations = exports.generateUvaPdf = exports.generateUvaXml = exports.runReceiptSearchForTransaction = exports.triggerFileMatchingWorker = exports.backfillSourcePartners = exports.getAccountBalances = exports.getBalanceAtDate = exports.deleteSource = exports.updateSource = exports.createSource = exports.removePartnerFromTransaction = exports.assignPartnerToTransaction = void 0;
exports.aiPluginManifest = exports.openApiSpec = exports.mcpSse = exports.mcpToolsList = exports.mcpApi = exports.setOnboardingTrack = exports.deactivateInvestmentsAddon = exports.activateInvestmentsAddon = exports.calculateCapitalGainsSummary = exports.calculateFifo = exports.matchInvestmentColumns = exports.bulkCreateTrades = exports.rejectReconciliation = exports.confirmReconciliation = exports.migrateInvoiceSources = exports.deleteBrowserRecipe = exports.updateBrowserRecipe = void 0;
const app_1 = require("firebase-admin/app");
// Initialize Firebase Admin
(0, app_1.initializeApp)();
// Export partner matching functions
var onPartnerCreate_1 = require("./matching/onPartnerCreate");
Object.defineProperty(exports, "onPartnerCreate", { enumerable: true, get: function () { return onPartnerCreate_1.onPartnerCreate; } });
var onPartnerUpdate_1 = require("./matching/onPartnerUpdate");
Object.defineProperty(exports, "onPartnerUpdate", { enumerable: true, get: function () { return onPartnerUpdate_1.onPartnerUpdate; } });
var matchPartners_1 = require("./matching/matchPartners");
Object.defineProperty(exports, "matchPartners", { enumerable: true, get: function () { return matchPartners_1.matchPartners; } });
var learnPartnerPatterns_1 = require("./matching/learnPartnerPatterns");
Object.defineProperty(exports, "learnPartnerPatterns", { enumerable: true, get: function () { return learnPartnerPatterns_1.learnPartnerPatterns; } });
var learnPartnerCategoryPatterns_1 = require("./matching/learnPartnerCategoryPatterns");
Object.defineProperty(exports, "learnPartnerCategoryPatterns", { enumerable: true, get: function () { return learnPartnerCategoryPatterns_1.learnPartnerCategoryPatterns; } });
var searchExternalPartners_1 = require("./matching/searchExternalPartners");
Object.defineProperty(exports, "searchExternalPartners", { enumerable: true, get: function () { return searchExternalPartners_1.searchExternalPartners; } });
var learnBillingCycle_1 = require("./matching/learnBillingCycle");
Object.defineProperty(exports, "learnBillingCycle", { enumerable: true, get: function () { return learnBillingCycle_1.learnBillingCycleCallable; } });
var learnScoringWeights_1 = require("./matching/learnScoringWeights");
Object.defineProperty(exports, "learnScoringWeights", { enumerable: true, get: function () { return learnScoringWeights_1.learnScoringWeightsCallable; } });
// Export analytics functions
var analyzeMatchAccuracy_1 = require("./analytics/analyzeMatchAccuracy");
Object.defineProperty(exports, "analyzeMatchAccuracy", { enumerable: true, get: function () { return analyzeMatchAccuracy_1.analyzeMatchAccuracyCallable; } });
var exportMatchIntelligence_1 = require("./analytics/exportMatchIntelligence");
Object.defineProperty(exports, "exportMatchIntelligence", { enumerable: true, get: function () { return exportMatchIntelligence_1.exportMatchIntelligenceCallable; } });
// Export category matching functions
var matchCategories_1 = require("./matching/matchCategories");
Object.defineProperty(exports, "matchCategories", { enumerable: true, get: function () { return matchCategories_1.matchCategories; } });
var onCategoryCreate_1 = require("./matching/onCategoryCreate");
Object.defineProperty(exports, "onCategoryCreate", { enumerable: true, get: function () { return onCategoryCreate_1.onCategoryCreate; } });
var onCategoryUpdate_1 = require("./matching/onCategoryUpdate");
Object.defineProperty(exports, "onCategoryUpdate", { enumerable: true, get: function () { return onCategoryUpdate_1.onCategoryUpdate; } });
var onTransactionUpdate_1 = require("./matching/onTransactionUpdate");
Object.defineProperty(exports, "onTransactionUpdate", { enumerable: true, get: function () { return onTransactionUpdate_1.onTransactionUpdate; } });
// Export user data update/create triggers (re-calculates file counterparties & syncs identity partners)
var onUserDataUpdate_1 = require("./matching/onUserDataUpdate");
Object.defineProperty(exports, "onUserDataUpdate", { enumerable: true, get: function () { return onUserDataUpdate_1.onUserDataUpdate; } });
Object.defineProperty(exports, "onUserDataCreated", { enumerable: true, get: function () { return onUserDataUpdate_1.onUserDataCreated; } });
// Export learning queue functions
var learningQueue_1 = require("./matching/learningQueue");
Object.defineProperty(exports, "queuePartnerForLearning", { enumerable: true, get: function () { return learningQueue_1.queuePartnerForLearning; } });
Object.defineProperty(exports, "processLearningQueue", { enumerable: true, get: function () { return learningQueue_1.processLearningQueue; } });
Object.defineProperty(exports, "triggerLearningNow", { enumerable: true, get: function () { return learningQueue_1.triggerLearningNow; } });
// Export admin functions
var generatePromotionCandidates_1 = require("./admin/generatePromotionCandidates");
Object.defineProperty(exports, "generatePromotionCandidates", { enumerable: true, get: function () { return generatePromotionCandidates_1.generatePromotionCandidates; } });
var fixIsCompleteFlag_1 = require("./admin/fixIsCompleteFlag");
Object.defineProperty(exports, "fixIsCompleteFlag", { enumerable: true, get: function () { return fixIsCompleteFlag_1.fixIsCompleteFlagCallable; } });
var aggregateGlobalInsights_1 = require("./admin/aggregateGlobalInsights");
Object.defineProperty(exports, "aggregateGlobalInsights", { enumerable: true, get: function () { return aggregateGlobalInsights_1.aggregateGlobalInsightsCallable; } });
Object.defineProperty(exports, "scheduledAggregateGlobalInsights", { enumerable: true, get: function () { return aggregateGlobalInsights_1.scheduledAggregateGlobalInsights; } });
var userManagement_1 = require("./admin/userManagement");
Object.defineProperty(exports, "listAllUsers", { enumerable: true, get: function () { return userManagement_1.listAllUsers; } });
Object.defineProperty(exports, "setUserOverride", { enumerable: true, get: function () { return userManagement_1.setUserOverride; } });
Object.defineProperty(exports, "switchTesterPlan", { enumerable: true, get: function () { return userManagement_1.switchTesterPlan; } });
// Export import functions
var matchColumns_1 = require("./import/matchColumns");
Object.defineProperty(exports, "matchColumns", { enumerable: true, get: function () { return matchColumns_1.matchColumns; } });
// Export file extraction functions
var extractFileData_1 = require("./extraction/extractFileData");
Object.defineProperty(exports, "extractFileData", { enumerable: true, get: function () { return extractFileData_1.extractFileData; } });
Object.defineProperty(exports, "extractFileDataOnUndelete", { enumerable: true, get: function () { return extractFileData_1.extractFileDataOnUndelete; } });
var retryExtraction_1 = require("./extraction/retryExtraction");
Object.defineProperty(exports, "retryFileExtraction", { enumerable: true, get: function () { return retryExtraction_1.retryFileExtraction; } });
// Export file-partner matching functions
var matchFilePartner_1 = require("./matching/matchFilePartner");
Object.defineProperty(exports, "matchFilePartner", { enumerable: true, get: function () { return matchFilePartner_1.matchFilePartner; } });
// Export file-transaction matching functions
var matchFileTransactions_1 = require("./matching/matchFileTransactions");
Object.defineProperty(exports, "matchFileTransactions", { enumerable: true, get: function () { return matchFileTransactions_1.matchFileTransactions; } });
var findTransactionMatches_1 = require("./matching/findTransactionMatches");
Object.defineProperty(exports, "findTransactionMatchesForFile", { enumerable: true, get: function () { return findTransactionMatches_1.findTransactionMatchesForFile; } });
var matchFilesForPartner_1 = require("./matching/matchFilesForPartner");
Object.defineProperty(exports, "matchFilesForPartner", { enumerable: true, get: function () { return matchFilesForPartner_1.matchFilesForPartner; } });
// Export orphaned file processing (fallback for stuck files)
var processOrphanedFiles_1 = require("./matching/processOrphanedFiles");
Object.defineProperty(exports, "processOrphanedFiles", { enumerable: true, get: function () { return processOrphanedFiles_1.processOrphanedFiles; } });
// Export AI helper functions
var generateFileSearchQuery_1 = require("./ai/generateFileSearchQuery");
Object.defineProperty(exports, "generateFileSearchQuery", { enumerable: true, get: function () { return generateFileSearchQuery_1.generateFileSearchQuery; } });
var lookupCompany_1 = require("./ai/lookupCompany");
Object.defineProperty(exports, "lookupCompany", { enumerable: true, get: function () { return lookupCompany_1.lookupCompany; } });
Object.defineProperty(exports, "lookupByVatId", { enumerable: true, get: function () { return lookupCompany_1.lookupByVatId; } });
// Export Gmail sync functions
var gmailSyncQueue_1 = require("./gmail/gmailSyncQueue");
Object.defineProperty(exports, "processGmailSyncQueue", { enumerable: true, get: function () { return gmailSyncQueue_1.processGmailSyncQueue; } });
Object.defineProperty(exports, "onSyncQueueCreated", { enumerable: true, get: function () { return gmailSyncQueue_1.onSyncQueueCreated; } });
var scheduledGmailSync_1 = require("./gmail/scheduledGmailSync");
Object.defineProperty(exports, "scheduledGmailSync", { enumerable: true, get: function () { return scheduledGmailSync_1.scheduledGmailSync; } });
var onMailServiceConnected_1 = require("./gmail/onMailServiceConnected");
Object.defineProperty(exports, "onMailServiceConnected", { enumerable: true, get: function () { return onMailServiceConnected_1.onMailServiceConnected; } });
Object.defineProperty(exports, "onMailServiceReconnected", { enumerable: true, get: function () { return onMailServiceConnected_1.onMailServiceReconnected; } });
var onTransactionsImported_1 = require("./gmail/onTransactionsImported");
Object.defineProperty(exports, "onTransactionsImported", { enumerable: true, get: function () { return onTransactionsImported_1.onTransactionsImported; } });
var onTransactionsImportedCompanyCheck_1 = require("./matching/onTransactionsImportedCompanyCheck");
Object.defineProperty(exports, "onTransactionsImportedCompanyCheck", { enumerable: true, get: function () { return onTransactionsImportedCompanyCheck_1.onTransactionsImportedCompanyCheck; } });
var searchGmailCallable_1 = require("./gmail/searchGmailCallable");
Object.defineProperty(exports, "searchGmailCallable", { enumerable: true, get: function () { return searchGmailCallable_1.searchGmailCallable; } });
// Export precision search functions
var precisionSearchQueue_1 = require("./precision-search/precisionSearchQueue");
Object.defineProperty(exports, "processPrecisionSearchQueue", { enumerable: true, get: function () { return precisionSearchQueue_1.processPrecisionSearchQueue; } });
Object.defineProperty(exports, "onPrecisionSearchQueueCreated", { enumerable: true, get: function () { return precisionSearchQueue_1.onPrecisionSearchQueueCreated; } });
var onGmailSyncComplete_1 = require("./precision-search/onGmailSyncComplete");
Object.defineProperty(exports, "onGmailSyncComplete", { enumerable: true, get: function () { return onGmailSyncComplete_1.onGmailSyncComplete; } });
var generateSearchQueriesCallable_1 = require("./precision-search/generateSearchQueriesCallable");
Object.defineProperty(exports, "generateSearchQueriesCallable", { enumerable: true, get: function () { return generateSearchQueriesCallable_1.generateSearchQueriesCallable; } });
var scoreAttachmentMatchCallable_1 = require("./precision-search/scoreAttachmentMatchCallable");
Object.defineProperty(exports, "scoreAttachmentMatchCallable", { enumerable: true, get: function () { return scoreAttachmentMatchCallable_1.scoreAttachmentMatchCallable; } });
var convertHtmlToPdfCallable_1 = require("./precision-search/convertHtmlToPdfCallable");
Object.defineProperty(exports, "convertHtmlToPdfCallable", { enumerable: true, get: function () { return convertHtmlToPdfCallable_1.convertHtmlToPdfCallable; } });
// Export inbound email functions
var receiveEmail_1 = require("./email-inbound/receiveEmail");
Object.defineProperty(exports, "receiveInboundEmail", { enumerable: true, get: function () { return receiveEmail_1.receiveInboundEmail; } });
Object.defineProperty(exports, "testInboundEmail", { enumerable: true, get: function () { return receiveEmail_1.testInboundEmail; } });
var resetDailyLimits_1 = require("./email-inbound/resetDailyLimits");
Object.defineProperty(exports, "resetInboundDailyLimits", { enumerable: true, get: function () { return resetDailyLimits_1.resetInboundDailyLimits; } });
// Export auth functions
var setAdminClaim_1 = require("./auth/setAdminClaim");
Object.defineProperty(exports, "setAdminClaim", { enumerable: true, get: function () { return setAdminClaim_1.setAdminClaim; } });
Object.defineProperty(exports, "beforeUserCreatedHandler", { enumerable: true, get: function () { return setAdminClaim_1.beforeUserCreatedHandler; } });
Object.defineProperty(exports, "listAdmins", { enumerable: true, get: function () { return setAdminClaim_1.listAdmins; } });
var validateRegistration_1 = require("./auth/validateRegistration");
Object.defineProperty(exports, "validateRegistration", { enumerable: true, get: function () { return validateRegistration_1.validateRegistration; } });
Object.defineProperty(exports, "markInviteUsed", { enumerable: true, get: function () { return validateRegistration_1.markInviteUsed; } });
var accessRequests_1 = require("./auth/accessRequests");
Object.defineProperty(exports, "submitAccessRequest", { enumerable: true, get: function () { return accessRequests_1.submitAccessRequest; } });
Object.defineProperty(exports, "approveAccessRequest", { enumerable: true, get: function () { return accessRequests_1.approveAccessRequest; } });
Object.defineProperty(exports, "dismissAccessRequest", { enumerable: true, get: function () { return accessRequests_1.dismissAccessRequest; } });
var migrateUserData_1 = require("./auth/migrateUserData");
Object.defineProperty(exports, "migrateUserData", { enumerable: true, get: function () { return migrateUserData_1.migrateUserData; } });
Object.defineProperty(exports, "checkMigrationStatus", { enumerable: true, get: function () { return migrateUserData_1.checkMigrationStatus; } });
// Export MFA functions
var mfaFunctions_1 = require("./auth/mfaFunctions");
Object.defineProperty(exports, "generateBackupCodes", { enumerable: true, get: function () { return mfaFunctions_1.generateBackupCodes; } });
Object.defineProperty(exports, "verifyBackupCode", { enumerable: true, get: function () { return mfaFunctions_1.verifyBackupCode; } });
Object.defineProperty(exports, "getMfaStatus", { enumerable: true, get: function () { return mfaFunctions_1.getMfaStatus; } });
Object.defineProperty(exports, "recordMfaSuccess", { enumerable: true, get: function () { return mfaFunctions_1.recordMfaSuccess; } });
Object.defineProperty(exports, "adminResetMfa", { enumerable: true, get: function () { return mfaFunctions_1.adminResetMfa; } });
Object.defineProperty(exports, "generatePasskeyRegistrationOptions", { enumerable: true, get: function () { return mfaFunctions_1.generatePasskeyRegistrationOptions; } });
Object.defineProperty(exports, "verifyPasskeyRegistration", { enumerable: true, get: function () { return mfaFunctions_1.verifyPasskeyRegistration; } });
Object.defineProperty(exports, "generatePasskeyAuthOptions", { enumerable: true, get: function () { return mfaFunctions_1.generatePasskeyAuthOptions; } });
Object.defineProperty(exports, "verifyPasskeyAuth", { enumerable: true, get: function () { return mfaFunctions_1.verifyPasskeyAuth; } });
Object.defineProperty(exports, "deletePasskey", { enumerable: true, get: function () { return mfaFunctions_1.deletePasskey; } });
Object.defineProperty(exports, "updateTotpStatus", { enumerable: true, get: function () { return mfaFunctions_1.updateTotpStatus; } });
Object.defineProperty(exports, "setUserPassword", { enumerable: true, get: function () { return mfaFunctions_1.setUserPassword; } });
// ============================================================================
// DATA OPERATIONS - All mutations go through Cloud Functions
// ============================================================================
// Transaction operations
var transactions_1 = require("./transactions");
Object.defineProperty(exports, "updateTransaction", { enumerable: true, get: function () { return transactions_1.updateTransactionCallable; } });
Object.defineProperty(exports, "bulkUpdateTransactions", { enumerable: true, get: function () { return transactions_1.bulkUpdateTransactionsCallable; } });
Object.defineProperty(exports, "deleteTransactionsBySource", { enumerable: true, get: function () { return transactions_1.deleteTransactionsBySourceCallable; } });
// File operations
var files_1 = require("./files");
Object.defineProperty(exports, "createFile", { enumerable: true, get: function () { return files_1.createFileCallable; } });
Object.defineProperty(exports, "updateFile", { enumerable: true, get: function () { return files_1.updateFileCallable; } });
Object.defineProperty(exports, "deleteFile", { enumerable: true, get: function () { return files_1.deleteFileCallable; } });
Object.defineProperty(exports, "restoreFile", { enumerable: true, get: function () { return files_1.restoreFileCallable; } });
Object.defineProperty(exports, "markFileAsNotInvoice", { enumerable: true, get: function () { return files_1.markFileAsNotInvoiceCallable; } });
Object.defineProperty(exports, "unmarkFileAsNotInvoice", { enumerable: true, get: function () { return files_1.unmarkFileAsNotInvoiceCallable; } });
Object.defineProperty(exports, "connectFileToTransaction", { enumerable: true, get: function () { return files_1.connectFileToTransactionCallable; } });
Object.defineProperty(exports, "disconnectFileFromTransaction", { enumerable: true, get: function () { return files_1.disconnectFileFromTransactionCallable; } });
Object.defineProperty(exports, "dismissTransactionSuggestion", { enumerable: true, get: function () { return files_1.dismissTransactionSuggestionCallable; } });
Object.defineProperty(exports, "unrejectFileFromTransaction", { enumerable: true, get: function () { return files_1.unrejectFileFromTransactionCallable; } });
// Import operations
var imports_1 = require("./imports");
Object.defineProperty(exports, "bulkCreateTransactions", { enumerable: true, get: function () { return imports_1.bulkCreateTransactionsCallable; } });
Object.defineProperty(exports, "createImportRecord", { enumerable: true, get: function () { return imports_1.createImportRecordCallable; } });
Object.defineProperty(exports, "createDraftImport", { enumerable: true, get: function () { return imports_1.createDraftImportCallable; } });
Object.defineProperty(exports, "updateDraftMappings", { enumerable: true, get: function () { return imports_1.updateDraftMappingsCallable; } });
Object.defineProperty(exports, "deleteDraftImport", { enumerable: true, get: function () { return imports_1.deleteDraftImportCallable; } });
Object.defineProperty(exports, "deleteImportRecord", { enumerable: true, get: function () { return imports_1.deleteImportRecordCallable; } });
Object.defineProperty(exports, "cleanupExpiredDrafts", { enumerable: true, get: function () { return imports_1.cleanupExpiredDrafts; } });
// Partner operations
var partners_1 = require("./partners");
Object.defineProperty(exports, "createUserPartner", { enumerable: true, get: function () { return partners_1.createUserPartnerCallable; } });
Object.defineProperty(exports, "updateUserPartner", { enumerable: true, get: function () { return partners_1.updateUserPartnerCallable; } });
Object.defineProperty(exports, "deleteUserPartner", { enumerable: true, get: function () { return partners_1.deleteUserPartnerCallable; } });
Object.defineProperty(exports, "assignPartnerToTransaction", { enumerable: true, get: function () { return partners_1.assignPartnerToTransactionCallable; } });
Object.defineProperty(exports, "removePartnerFromTransaction", { enumerable: true, get: function () { return partners_1.removePartnerFromTransactionCallable; } });
// Source operations
var sources_1 = require("./sources");
Object.defineProperty(exports, "createSource", { enumerable: true, get: function () { return sources_1.createSourceCallable; } });
Object.defineProperty(exports, "updateSource", { enumerable: true, get: function () { return sources_1.updateSourceCallable; } });
Object.defineProperty(exports, "deleteSource", { enumerable: true, get: function () { return sources_1.deleteSourceCallable; } });
Object.defineProperty(exports, "getBalanceAtDate", { enumerable: true, get: function () { return sources_1.getBalanceAtDateCallable; } });
Object.defineProperty(exports, "getAccountBalances", { enumerable: true, get: function () { return sources_1.getAccountBalancesCallable; } });
Object.defineProperty(exports, "backfillSourcePartners", { enumerable: true, get: function () { return sources_1.backfillSourcePartnersCallable; } });
// Worker operations
var triggerFileMatchingWorker_1 = require("./workers/triggerFileMatchingWorker");
Object.defineProperty(exports, "triggerFileMatchingWorker", { enumerable: true, get: function () { return triggerFileMatchingWorker_1.triggerFileMatchingWorkerCallable; } });
var runReceiptSearchForTransaction_1 = require("./workers/runReceiptSearchForTransaction");
Object.defineProperty(exports, "runReceiptSearchForTransaction", { enumerable: true, get: function () { return runReceiptSearchForTransaction_1.runReceiptSearchForTransactionCallable; } });
// Report operations
var reports_1 = require("./reports");
Object.defineProperty(exports, "generateUvaXml", { enumerable: true, get: function () { return reports_1.generateUvaXmlCallable; } });
Object.defineProperty(exports, "generateUvaPdf", { enumerable: true, get: function () { return reports_1.generateUvaPdfCallable; } });
// Automation registry (for admin page)
var automation_1 = require("./automation");
Object.defineProperty(exports, "getAutomations", { enumerable: true, get: function () { return automation_1.getAutomationsCallable; } });
// User data export operations
var user_export_1 = require("./user-export");
Object.defineProperty(exports, "requestUserExport", { enumerable: true, get: function () { return user_export_1.requestUserExportCallable; } });
Object.defineProperty(exports, "processUserExportOnCreate", { enumerable: true, get: function () { return user_export_1.processUserExportOnCreate; } });
Object.defineProperty(exports, "processUserExportScheduled", { enumerable: true, get: function () { return user_export_1.processUserExportScheduled; } });
Object.defineProperty(exports, "cleanupExpiredExports", { enumerable: true, get: function () { return user_export_1.cleanupExpiredExports; } });
// User data import operations
var user_import_1 = require("./user-import");
Object.defineProperty(exports, "validateUserImport", { enumerable: true, get: function () { return user_import_1.validateUserImportCallable; } });
Object.defineProperty(exports, "executeUserImport", { enumerable: true, get: function () { return user_import_1.executeUserImportCallable; } });
Object.defineProperty(exports, "processUserImportOnUpdate", { enumerable: true, get: function () { return user_import_1.processUserImportOnUpdate; } });
// User account operations
var deleteUserAccountCallable_1 = require("./user/deleteUserAccountCallable");
Object.defineProperty(exports, "deleteUserAccount", { enumerable: true, get: function () { return deleteUserAccountCallable_1.deleteUserAccountCallable; } });
var scheduleAccountDeletionCallable_1 = require("./user/scheduleAccountDeletionCallable");
Object.defineProperty(exports, "scheduleAccountDeletion", { enumerable: true, get: function () { return scheduleAccountDeletionCallable_1.scheduleAccountDeletionCallable; } });
var cancelAccountDeletionCallable_1 = require("./user/cancelAccountDeletionCallable");
Object.defineProperty(exports, "cancelAccountDeletion", { enumerable: true, get: function () { return cancelAccountDeletionCallable_1.cancelAccountDeletionCallable; } });
var processPendingDeletions_1 = require("./user/processPendingDeletions");
Object.defineProperty(exports, "processPendingDeletions", { enumerable: true, get: function () { return processPendingDeletions_1.processPendingDeletions; } });
// BMD NTCS export operations
var bmd_export_1 = require("./bmd-export");
Object.defineProperty(exports, "requestBmdExport", { enumerable: true, get: function () { return bmd_export_1.requestBmdExportCallable; } });
Object.defineProperty(exports, "processBmdExportOnCreate", { enumerable: true, get: function () { return bmd_export_1.processBmdExportOnCreate; } });
// FinanzOnline WebService operations
var credentialCallables_1 = require("./finanzonline/credentialCallables");
Object.defineProperty(exports, "saveFinanzOnlineCredentials", { enumerable: true, get: function () { return credentialCallables_1.saveFinanzOnlineCredentialsCallable; } });
Object.defineProperty(exports, "testFinanzOnlineConnection", { enumerable: true, get: function () { return credentialCallables_1.testFinanzOnlineConnectionCallable; } });
Object.defineProperty(exports, "deleteFinanzOnlineCredentials", { enumerable: true, get: function () { return credentialCallables_1.deleteFinanzOnlineCredentialsCallable; } });
var submitUvaCallable_1 = require("./finanzonline/submitUvaCallable");
Object.defineProperty(exports, "submitUvaToFinanzOnline", { enumerable: true, get: function () { return submitUvaCallable_1.submitUvaToFinanzOnlineCallable; } });
// finAPI banking integration (legacy - use syncBankTransactions instead)
var syncCallable_1 = require("./finapi/syncCallable");
Object.defineProperty(exports, "syncFinapiTransactions", { enumerable: true, get: function () { return syncCallable_1.syncFinapiTransactions; } });
// Banking operations (new - with orphan handling and full deduplication)
var banking_1 = require("./banking");
Object.defineProperty(exports, "syncBankTransactions", { enumerable: true, get: function () { return banking_1.syncBankTransactionsCallable; } });
Object.defineProperty(exports, "cleanupOrphanedTransactions", { enumerable: true, get: function () { return banking_1.cleanupOrphanedTransactionsCallable; } });
Object.defineProperty(exports, "createBankingConnection", { enumerable: true, get: function () { return banking_1.createBankingConnectionCallable; } });
Object.defineProperty(exports, "initiateBankConnection", { enumerable: true, get: function () { return banking_1.initiateBankConnectionCallable; } });
Object.defineProperty(exports, "updateBankingConnection", { enumerable: true, get: function () { return banking_1.updateBankingConnectionCallable; } });
Object.defineProperty(exports, "deleteBankingConnection", { enumerable: true, get: function () { return banking_1.deleteBankingConnectionCallable; } });
Object.defineProperty(exports, "createApiSource", { enumerable: true, get: function () { return banking_1.createApiSourceCallable; } });
Object.defineProperty(exports, "updateSourceApiConfig", { enumerable: true, get: function () { return banking_1.updateSourceApiConfigCallable; } });
Object.defineProperty(exports, "listBankInstitutions", { enumerable: true, get: function () { return banking_1.listBankInstitutionsCallable; } });
// API key management (for external integrations)
var api_keys_1 = require("./api-keys");
Object.defineProperty(exports, "createApiKey", { enumerable: true, get: function () { return api_keys_1.createApiKeyCallable; } });
Object.defineProperty(exports, "listApiKeys", { enumerable: true, get: function () { return api_keys_1.listApiKeysCallable; } });
Object.defineProperty(exports, "revokeApiKey", { enumerable: true, get: function () { return api_keys_1.revokeApiKeyCallable; } });
// Billing operations
var billing_1 = require("./billing");
Object.defineProperty(exports, "createCheckoutSession", { enumerable: true, get: function () { return billing_1.createCheckoutSessionCallable; } });
Object.defineProperty(exports, "createPortalSession", { enumerable: true, get: function () { return billing_1.createPortalSessionCallable; } });
Object.defineProperty(exports, "addAICredits", { enumerable: true, get: function () { return billing_1.addAICreditsCallable; } });
Object.defineProperty(exports, "updateOverageSettings", { enumerable: true, get: function () { return billing_1.updateOverageSettingsCallable; } });
Object.defineProperty(exports, "stripeWebhook", { enumerable: true, get: function () { return billing_1.stripeWebhook; } });
var updateAutomationMode_1 = require("./billing/updateAutomationMode");
Object.defineProperty(exports, "updateAutomationMode", { enumerable: true, get: function () { return updateAutomationMode_1.updateAutomationModeCallable; } });
// Browser recipe operations
var saveBrowserRecipe_1 = require("./browser/saveBrowserRecipe");
Object.defineProperty(exports, "saveBrowserRecipe", { enumerable: true, get: function () { return saveBrowserRecipe_1.saveBrowserRecipeCallable; } });
var updateBrowserRecipe_1 = require("./browser/updateBrowserRecipe");
Object.defineProperty(exports, "updateBrowserRecipe", { enumerable: true, get: function () { return updateBrowserRecipe_1.updateBrowserRecipeCallable; } });
var deleteBrowserRecipe_1 = require("./browser/deleteBrowserRecipe");
Object.defineProperty(exports, "deleteBrowserRecipe", { enumerable: true, get: function () { return deleteBrowserRecipe_1.deleteBrowserRecipeCallable; } });
var migrateInvoiceSources_1 = require("./browser/migrateInvoiceSources");
Object.defineProperty(exports, "migrateInvoiceSources", { enumerable: true, get: function () { return migrateInvoiceSources_1.migrateInvoiceSourcesCallable; } });
// Card reconciliation operations (processReconciliation is now a utility called from onTransactionUpdate)
var confirmReconciliation_1 = require("./reconciliation/confirmReconciliation");
Object.defineProperty(exports, "confirmReconciliation", { enumerable: true, get: function () { return confirmReconciliation_1.confirmReconciliationCallable; } });
var rejectReconciliation_1 = require("./reconciliation/rejectReconciliation");
Object.defineProperty(exports, "rejectReconciliation", { enumerable: true, get: function () { return rejectReconciliation_1.rejectReconciliationCallable; } });
// Investment operations
var investments_1 = require("./investments");
Object.defineProperty(exports, "bulkCreateTrades", { enumerable: true, get: function () { return investments_1.bulkCreateTradesCallable; } });
Object.defineProperty(exports, "matchInvestmentColumns", { enumerable: true, get: function () { return investments_1.matchInvestmentColumns; } });
Object.defineProperty(exports, "calculateFifo", { enumerable: true, get: function () { return investments_1.calculateFifoCallable; } });
Object.defineProperty(exports, "calculateCapitalGainsSummary", { enumerable: true, get: function () { return investments_1.calculateCapitalGainsSummaryCallable; } });
// Billing addon operations
var investmentsAddon_1 = require("./billing/investmentsAddon");
Object.defineProperty(exports, "activateInvestmentsAddon", { enumerable: true, get: function () { return investmentsAddon_1.activateInvestmentsAddonCallable; } });
Object.defineProperty(exports, "deactivateInvestmentsAddon", { enumerable: true, get: function () { return investmentsAddon_1.deactivateInvestmentsAddonCallable; } });
// Onboarding operations
var setOnboardingTrackCallable_1 = require("./onboarding/setOnboardingTrackCallable");
Object.defineProperty(exports, "setOnboardingTrack", { enumerable: true, get: function () { return setOnboardingTrackCallable_1.setOnboardingTrackCallable; } });
// MCP HTTP API (for OpenClaw, Claude Desktop, ChatGPT, etc.)
var mcp_api_1 = require("./mcp-api");
Object.defineProperty(exports, "mcpApi", { enumerable: true, get: function () { return mcp_api_1.mcpApi; } });
Object.defineProperty(exports, "mcpToolsList", { enumerable: true, get: function () { return mcp_api_1.mcpToolsList; } });
Object.defineProperty(exports, "mcpSse", { enumerable: true, get: function () { return mcp_api_1.mcpSse; } });
var openapi_1 = require("./mcp-api/openapi");
Object.defineProperty(exports, "openApiSpec", { enumerable: true, get: function () { return openapi_1.openApiSpec; } });
Object.defineProperty(exports, "aiPluginManifest", { enumerable: true, get: function () { return openapi_1.aiPluginManifest; } });
//# sourceMappingURL=index.js.map