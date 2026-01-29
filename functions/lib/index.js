"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateRegistration = exports.listAdmins = exports.beforeUserCreatedHandler = exports.setAdminClaim = exports.resetInboundDailyLimits = exports.testInboundEmail = exports.receiveInboundEmail = exports.convertHtmlToPdfCallable = exports.scoreAttachmentMatchCallable = exports.generateSearchQueriesCallable = exports.onGmailSyncComplete = exports.onPrecisionSearchQueueCreated = exports.processPrecisionSearchQueue = exports.searchGmailCallable = exports.onTransactionsImported = exports.onGmailReconnected = exports.onGmailConnected = exports.scheduledGmailSync = exports.onSyncQueueCreated = exports.processGmailSyncQueue = exports.lookupByVatId = exports.lookupCompany = exports.generateFileSearchQuery = exports.processOrphanedFiles = exports.matchFilesForPartner = exports.findTransactionMatchesForFile = exports.matchFileTransactions = exports.matchFilePartner = exports.retryFileExtraction = exports.extractFileDataOnUndelete = exports.extractFileData = exports.sendReauthReminders = exports.triggerGoCardlessSync = exports.scheduledGoCardlessSync = exports.matchColumns = exports.fixIsCompleteFlag = exports.generatePromotionCandidates = exports.triggerLearningNow = exports.processLearningQueue = exports.queuePartnerForLearning = exports.onUserDataUpdate = exports.onTransactionUpdate = exports.onCategoryUpdate = exports.onCategoryCreate = exports.matchCategories = exports.searchExternalPartners = exports.learnPartnerPatterns = exports.matchPartners = exports.onPartnerUpdate = exports.onPartnerCreate = void 0;
exports.processUserExportOnCreate = exports.requestUserExport = exports.getAutomations = exports.generateUvaPdf = exports.generateUvaXml = exports.runReceiptSearchForTransaction = exports.triggerFileMatchingWorker = exports.deleteSource = exports.updateSource = exports.createSource = exports.removePartnerFromTransaction = exports.assignPartnerToTransaction = exports.deleteUserPartner = exports.updateUserPartner = exports.createUserPartner = exports.cleanupExpiredDrafts = exports.deleteImportRecord = exports.deleteDraftImport = exports.updateDraftMappings = exports.createDraftImport = exports.createImportRecord = exports.bulkCreateTransactions = exports.unrejectFileFromTransaction = exports.dismissTransactionSuggestion = exports.disconnectFileFromTransaction = exports.connectFileToTransaction = exports.unmarkFileAsNotInvoice = exports.markFileAsNotInvoice = exports.restoreFile = exports.deleteFile = exports.updateFile = exports.createFile = exports.deleteTransactionsBySource = exports.bulkUpdateTransactions = exports.updateTransaction = exports.setUserPassword = exports.updateTotpStatus = exports.deletePasskey = exports.verifyPasskeyAuth = exports.generatePasskeyAuthOptions = exports.verifyPasskeyRegistration = exports.generatePasskeyRegistrationOptions = exports.adminResetMfa = exports.recordMfaSuccess = exports.getMfaStatus = exports.verifyBackupCode = exports.generateBackupCodes = exports.checkMigrationStatus = exports.migrateUserData = exports.markInviteUsed = void 0;
exports.processUserImportOnUpdate = exports.executeUserImport = exports.validateUserImport = exports.cleanupExpiredExports = exports.processUserExportScheduled = void 0;
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
var searchExternalPartners_1 = require("./matching/searchExternalPartners");
Object.defineProperty(exports, "searchExternalPartners", { enumerable: true, get: function () { return searchExternalPartners_1.searchExternalPartners; } });
// Export category matching functions
var matchCategories_1 = require("./matching/matchCategories");
Object.defineProperty(exports, "matchCategories", { enumerable: true, get: function () { return matchCategories_1.matchCategories; } });
var onCategoryCreate_1 = require("./matching/onCategoryCreate");
Object.defineProperty(exports, "onCategoryCreate", { enumerable: true, get: function () { return onCategoryCreate_1.onCategoryCreate; } });
var onCategoryUpdate_1 = require("./matching/onCategoryUpdate");
Object.defineProperty(exports, "onCategoryUpdate", { enumerable: true, get: function () { return onCategoryUpdate_1.onCategoryUpdate; } });
var onTransactionUpdate_1 = require("./matching/onTransactionUpdate");
Object.defineProperty(exports, "onTransactionUpdate", { enumerable: true, get: function () { return onTransactionUpdate_1.onTransactionUpdate; } });
// Export user data update trigger (re-calculates file counterparties)
var onUserDataUpdate_1 = require("./matching/onUserDataUpdate");
Object.defineProperty(exports, "onUserDataUpdate", { enumerable: true, get: function () { return onUserDataUpdate_1.onUserDataUpdate; } });
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
// Export import functions
var matchColumns_1 = require("./import/matchColumns");
Object.defineProperty(exports, "matchColumns", { enumerable: true, get: function () { return matchColumns_1.matchColumns; } });
// Export GoCardless sync functions
var scheduledSync_1 = require("./gocardless/scheduledSync");
Object.defineProperty(exports, "scheduledGoCardlessSync", { enumerable: true, get: function () { return scheduledSync_1.scheduledGoCardlessSync; } });
Object.defineProperty(exports, "triggerGoCardlessSync", { enumerable: true, get: function () { return scheduledSync_1.triggerGoCardlessSync; } });
Object.defineProperty(exports, "sendReauthReminders", { enumerable: true, get: function () { return scheduledSync_1.sendReauthReminders; } });
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
var onGmailConnected_1 = require("./gmail/onGmailConnected");
Object.defineProperty(exports, "onGmailConnected", { enumerable: true, get: function () { return onGmailConnected_1.onGmailConnected; } });
Object.defineProperty(exports, "onGmailReconnected", { enumerable: true, get: function () { return onGmailConnected_1.onGmailReconnected; } });
var onTransactionsImported_1 = require("./gmail/onTransactionsImported");
Object.defineProperty(exports, "onTransactionsImported", { enumerable: true, get: function () { return onTransactionsImported_1.onTransactionsImported; } });
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
//# sourceMappingURL=index.js.map