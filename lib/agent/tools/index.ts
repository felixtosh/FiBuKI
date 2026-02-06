/**
 * Agent Tools Index
 *
 * Re-exports all tools organized by category.
 * These tools are used by the LangGraph agent.
 */

export * from "./read-tools";
export * from "./navigation-tools";
export * from "./write-tools";
export * from "./search-tools";
export * from "./download-tools";
export * from "./batch-tools";

// Tool arrays for the agent
import { READ_TOOLS } from "./read-tools";
import { NAVIGATION_TOOLS } from "./navigation-tools";
import { WRITE_TOOLS } from "./write-tools";
import { SEARCH_TOOLS } from "./search-tools";
import { DOWNLOAD_TOOLS } from "./download-tools";
import { BATCH_TOOLS } from "./batch-tools";

/**
 * All tools available to the agent
 */
export const ALL_TOOLS = [
  ...READ_TOOLS,
  ...NAVIGATION_TOOLS,
  ...WRITE_TOOLS,
  ...SEARCH_TOOLS,
  ...DOWNLOAD_TOOLS,
  ...BATCH_TOOLS,
];

/**
 * Tools that require user confirmation before execution
 *
 * Note: Partner tools (createPartner, assignPartnerToTransaction, findOrCreatePartner)
 * do NOT require confirmation as they are low-risk and users typically want them
 * executed immediately when asked.
 *
 * Note: Download tools (downloadGmailAttachment, convertEmailToPdf) do NOT require
 * confirmation - the agent should just download when it finds a reasonable match.
 */
export const TOOLS_REQUIRING_CONFIRMATION = [
  "updateTransaction",
  "createSource",
  "rollbackTransaction",
];

/**
 * Check if a tool requires confirmation
 */
export function requiresConfirmation(toolName: string): boolean {
  return TOOLS_REQUIRING_CONFIRMATION.includes(toolName);
}
