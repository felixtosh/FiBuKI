/**
 * Worker Configurations
 *
 * Defines the configuration for each worker type including
 * allowed tools, prompts, and execution limits.
 */

import { WorkerConfig, WorkerType } from "@/types/worker";

/**
 * Worker configurations by type
 */
export const WORKER_CONFIGS: Record<WorkerType, WorkerConfig> = {
  file_matching: {
    type: "file_matching",
    name: "File Matcher",
    description: "Searches for and connects receipts/invoices to transactions",
    toolNames: [
      // Search tools
      "generateSearchSuggestions",
      "searchLocalFiles",
      "searchGmailAttachments",
      "searchGmailEmails",
      "analyzeEmail",
      // Connection tool
      "connectFileToTransaction",
      // Download tools
      "downloadGmailAttachment",
      "convertEmailToPdf",
      // Read tools (for context)
      "getTransaction",
      "listTransactions",
      "listFiles",
      "getFile",
    ],
    systemPromptKey: "file_matching",
    maxMessages: 20,
    maxToolCalls: 15,
    timeoutSeconds: 120,
  },

  partner_matching: {
    type: "partner_matching",
    name: "Partner Matcher",
    description: "Identifies and assigns partners to transactions",
    toolNames: [
      // Read tools (for context)
      "getTransaction",
      "listPartners",
      "getPartner",
      // Search user's own data for clues (bank names are often cryptic)
      "searchGmailEmails", // Emails have full company names, domains
      "listFiles", // Invoices have proper company names
      "getFile", // Get file details
      "listTransactions", // Similar transactions may have partners
      // Lookup tools (read-only, for web search)
      "lookupCompanyInfo",
      "validateVatId",
      // Write tools
      "createPartner",
      "assignPartnerToTransaction",
      // Connect file if found during search
      "downloadGmailAttachment",
      "waitForFileExtraction",
      "connectFileToTransaction",
    ],
    systemPromptKey: "partner_matching",
    maxMessages: 25,
    maxToolCalls: 18,
    timeoutSeconds: 120,
  },

  file_partner_matching: {
    type: "file_partner_matching",
    name: "File Partner Matcher",
    description: "Identifies and assigns partners to files/invoices",
    toolNames: [
      // Read tools (for context)
      "getFile",
      "listPartners",
      "getPartner",
      // Search user's own data
      "searchGmailEmails",
      "searchGmailAttachments",
      "listFiles",
      "listTransactions",
      // Lookup tools
      "lookupCompanyInfo",
      "validateVatId",
      // Write tools
      "createPartner",
      "assignPartnerToFile",
    ],
    systemPromptKey: "file_partner_matching",
    maxMessages: 20,
    maxToolCalls: 15,
    timeoutSeconds: 90,
  },

  receipt_search: {
    type: "receipt_search",
    name: "Receipt Finder",
    description: "Searches for receipts/invoices for transactions",
    toolNames: [
      // AI-generated search queries
      "generateSearchSuggestions",
      // Search tools
      "searchLocalFiles",
      "searchGmailAttachments",
      "searchGmailEmails",
      "analyzeEmail",
      // Connection tool
      "connectFileToTransaction",
      // Download tools
      "downloadGmailAttachment",
      "convertEmailToPdf",
      // Read tools (for context)
      "getTransaction",
      "listFiles",
      "getFile",
      "waitForFileExtraction",
    ],
    systemPromptKey: "receipt_search",
    maxMessages: 30,
    maxToolCalls: 20, // Slightly higher - needs search, download, wait, verify cycles
    timeoutSeconds: 120,
  },

  partner_file_batch: {
    type: "partner_file_batch",
    name: "Partner File Batch Matcher",
    description:
      "Batches all unmatched files for a partner into one intelligent agent run. " +
      "Searches Gmail/local once for the whole partner, scores NxM, and bulk-connects matches.",
    toolNames: [
      // Batch-specific tools
      "loadPartnerBatchContext",
      "searchGmailForPartner",
      "searchLocalFilesForPartner",
      "scoreBatchMatches",
      "bulkConnectFiles",
      "updateBatchTaskList",
      // Fallback individual tools
      "getFile",
      "getTransaction",
      "listTransactions",
      "downloadGmailAttachment",
      "waitForFileExtraction",
      "connectFileToTransaction",
    ],
    systemPromptKey: "partner_file_batch",
    maxMessages: 40,
    maxToolCalls: 30,
    timeoutSeconds: 180,
  },
};

/**
 * Get worker config by type
 */
export function getWorkerConfig(type: WorkerType): WorkerConfig {
  const config = WORKER_CONFIGS[type];
  if (!config) {
    throw new Error(`Unknown worker type: ${type}`);
  }
  return config;
}

/**
 * Get all worker types
 */
export function getAllWorkerTypes(): WorkerType[] {
  return Object.keys(WORKER_CONFIGS) as WorkerType[];
}
