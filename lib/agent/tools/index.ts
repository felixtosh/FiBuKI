/**
 * Agent Tools Index
 *
 * Two sets:
 * - CHAT_TOOLS: what the sidebar chat's model is given.
 * - ALL_TOOLS: the pool the background workers pick their toolNames from
 *   (lib/agent/worker-configs.ts). It adds the Partner batch tools, which only
 *   the partner_file_batch worker uses.
 *
 * A chat tool is a wrapper over its MCP twin (./mcp-tools) unless it is in
 * CHAT_ONLY_TOOLS below with the reason it cannot be one yet. The test in
 * lib/agent/tools/inventory.test.ts fails on a chat tool that is neither, so
 * the chat's surface does not grow beside the shared one unnoticed.
 */

export * from "./mcp-tools";
export * from "./read-tools";
export * from "./navigation-tools";
export * from "./write-tools";
export * from "./search-tools";
export * from "./download-tools";
export * from "./batch-tools";
export * from "./choice-tools";

import { READ_TOOLS } from "./read-tools";
import { NAVIGATION_TOOLS } from "./navigation-tools";
import { WRITE_TOOLS } from "./write-tools";
import { SEARCH_TOOLS } from "./search-tools";
import { DOWNLOAD_TOOLS } from "./download-tools";
import { BATCH_TOOLS } from "./batch-tools";
import { CHOICE_TOOLS } from "./choice-tools";

export { TOOLS_REQUIRING_CONFIRMATION, requiresConfirmation } from "../choices";

/** The sidebar chat's tools. */
export const CHAT_TOOLS = [
  ...READ_TOOLS,
  ...NAVIGATION_TOOLS,
  ...WRITE_TOOLS,
  ...SEARCH_TOOLS,
  ...DOWNLOAD_TOOLS,
  ...CHOICE_TOOLS,
];

/** Every tool a worker may be configured with. */
export const ALL_TOOLS = [
  ...READ_TOOLS,
  ...NAVIGATION_TOOLS,
  ...WRITE_TOOLS,
  ...SEARCH_TOOLS,
  ...DOWNLOAD_TOOLS,
  ...BATCH_TOOLS,
];

/**
 * Chat tools without an MCP twin, and why. Shrink this list by adding the MCP
 * tool and wrapping it; grow it only with a reason an external agent could not
 * use the same tool.
 */
export const CHAT_ONLY_TOOLS: Record<string, string> = {
  // The chat's UI
  presentChoices: "Renders clickable options in the sidebar; an external agent has its own UI.",
  navigateTo: "Moves the user's screen.",
  openTransactionSheet: "Moves the user's screen.",
  scrollToTransaction: "Moves the user's screen.",
  // Session-bound sources: the user's own mailbox tokens and the web container's queues
  searchGmailAttachments: "Reads the user's connected mailboxes through the web container's mail clients.",
  searchGmailEmails: "Reads the user's connected mailboxes through the web container's mail clients.",
  analyzeEmail: "Reads one mail through the web container's mail clients.",
  downloadGmailAttachment: "Stores a mail attachment through the web container's mail clients.",
  convertEmailToPdf: "Renders a mail to PDF in the web container.",
  getQueueStatus: "Reports the web container's processing queues.",
  waitForFileExtraction: "Polls one File until extraction finishes; MCP clients poll get_file themselves.",
  // Receipt and Partner search: matcher callables without an MCP tool yet
  findReceiptForTransaction: "The receipt workflow callable; candidate for an MCP tool.",
  searchLocalFiles: "The matcher's findFileMatchesForTransaction callable; candidate for an MCP tool.",
  generateSearchSuggestions: "The search-query callable; candidate for an MCP tool.",
  getPartnerReceiptHints: "Reads a Partner's learned receipt sources; candidate for an MCP tool.",
  lookupCompanyInfo: "The company lookup callable (web search); candidate for an MCP tool.",
  validateVatId: "The VIES lookup callable; candidate for an MCP tool.",
  matchTransactionPartners: "Runs the Partner matcher on a set; candidate for an MCP tool.",
  // Writes with their own callable and no MCP twin yet
  bulkUpdateTransactions: "The bulk edit callable; MCP has update_transaction one at a time.",
  rollbackTransaction: "The rollback callable; MCP has no history tools.",
  getTransactionHistory: "Reads a Transaction's edit history; MCP has no history tools.",
};
