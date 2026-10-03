/**
 * MCP tool annotations (spec 2025-06-18+).
 *
 * ChatGPT, Codex and Claude read these hints to decide when to ask the user
 * before a call. They are hints, never authorization: every handler still
 * checks the user itself.
 *
 * Every tool in TOOL_DEFINITIONS must appear in exactly one of the lists
 * below; tool-annotations.test.ts fails the build when a new tool is added
 * without a decision here.
 */

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/** Cannot change any state. */
export const READ_ONLY_TOOLS = [
  "list_sources",
  "get_source",
  "list_transactions",
  "get_transaction",
  "list_transactions_needing_files",
  "list_transactions_missing_invoice",
  "list_files",
  "get_file",
  "get_correction",
  "score_file_transaction_match",
  "list_identity_entities",
  "list_partners",
  "get_partner",
  "list_recurring_partners",
  "partner_rematch_report",
  "list_no_receipt_categories",
  "get_uva_report",
  "list_invoices",
  "get_invoice",
  "get_automation_status",
  "get_profile",
  "get_period_status",
  "list_pending_matches",
] as const;

/**
 * Writes that are irreversible or hard to undo, so a client should confirm:
 * - delete_source: cascades to every Transaction of the Bank Account
 * - import_transactions: a Transaction can only leave with its whole source
 * - merge_partners: one-way (ADR-0005)
 * - issue_invoice / cancel_invoice / undo_issue_invoice: legal numbering, Storno, PDF destroyed
 * - reclassify_documents / rematch_assigned_partners: rewrite the whole account
 * - retry_file_extraction: resets the File's Partner and Transaction matching
 */
export const DESTRUCTIVE_TOOLS = [
  "delete_source",
  "import_transactions",
  "merge_partners",
  "issue_invoice",
  "cancel_invoice",
  "undo_issue_invoice",
  "reclassify_documents",
  "rematch_assigned_partners",
  "retry_file_extraction",
] as const;

/** Ordinary writes inside the user's own account; reversible. */
export const WRITE_TOOLS = [
  "create_source",
  "update_transaction",
  "accept_receipt_only",
  "accept_partial_payment",
  "delete_file", // reversible: restore_file (ADR-0006)
  "restore_file",
  "split_file", // reversible: delete the parts, then restore_file the original
  "dismiss_split_suggestion", // no undo, but loses nothing: split_file still takes explicit ranges
  "connect_file_to_transaction",
  "disconnect_file_from_transaction",
  "confirm_file_recipient_is_user",
  "unconfirm_file_recipient_is_user",
  "mark_file_vat_not_claimable",
  "unmark_file_vat_not_claimable",
  "dismiss_transaction_suggestion",
  "undismiss_transaction_suggestion",
  "mark_file_as_not_invoice",
  "unmark_file_as_not_invoice",
  "mark_file_as_copy", // a moved or removed File Connection stays with the original; undone by unmark_file_as_copy
  "unmark_file_as_copy",
  "make_file_the_original",
  "link_correction",
  "unlink_correction", // the link is the only state; link_correction restores it
  "update_file_extraction",
  "auto_connect_file_suggestions",
  "upload_file",
  "update_identity_entity",
  "create_identity_entity",
  "get_onboarding_status", // records steps the user's data completed; idempotent
  "skip_onboarding_step",
  "set_partner_billing_cycle",
  "create_partner",
  "update_partner",
  "assign_partner_to_transaction",
  "remove_partner_from_transaction",
  "assign_partner_to_file",
  "remove_partner_from_file",
  "assign_no_receipt_category",
  "remove_no_receipt_category",
  "create_invoice",
  "update_invoice",
  "duplicate_invoice",
] as const;

/** Tools that reach outside the user's FiBuKI account (upload_file fetches a URL). */
const OPEN_WORLD_TOOLS = new Set<string>(["upload_file"]);

const readOnly = new Set<string>(READ_ONLY_TOOLS);
const destructive = new Set<string>(DESTRUCTIVE_TOOLS);

/** "list_transactions_needing_files" -> "List transactions needing files" */
export function toolTitle(name: string): string {
  const words = name.split("_").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function annotationsFor(name: string): ToolAnnotations {
  const isReadOnly = readOnly.has(name);
  return {
    title: toolTitle(name),
    readOnlyHint: isReadOnly,
    destructiveHint: !isReadOnly && destructive.has(name),
    openWorldHint: OPEN_WORLD_TOOLS.has(name),
  };
}
