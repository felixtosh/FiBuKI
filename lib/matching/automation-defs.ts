/**
 * @deprecated This file is deprecated and will be removed.
 *
 * The new automation registry is in functions/src/automation/
 * - Types: functions/src/automation/types.ts
 * - Registry: functions/src/automation/automation-registry.ts
 * - Callable: functions/src/automation/getAutomationsCallable.ts
 *
 * Automation metadata is now co-located with Cloud Function triggers
 * (e.g., matchFilePartner.ts exports AUTOMATION_META).
 *
 * The admin page at /admin/automation now fetches from the getAutomations callable.
 *
 * For MCP server, run: npm run generate:mcp-automations
 * This generates mcp-server/src/generated/automations.ts
 *
 * ============================================================================
 * LEGACY FILE - KEEP FOR BACKWARD COMPATIBILITY DURING TRANSITION
 * ============================================================================
 */

import type { AutomationStep, AutomationPipeline, PipelineId } from "@/types/automation";
import { TRANSACTION_MATCH_CONFIG } from "./transaction-matcher";

// ============================================================================
// PARTNER MATCHING AUTOMATIONS
// ============================================================================

/**
 * Partner matching configuration
 * These values are used by partner-matcher.ts
 */
export const PARTNER_MATCH_CONFIG = {
  /** Threshold for auto-applying partner matches */
  AUTO_APPLY_THRESHOLD: 89,
  /** IBAN match confidence (exact bank account match) */
  IBAN_CONFIDENCE: 100,
  /** VAT ID match confidence */
  VAT_CONFIDENCE: 95,
  /** Website match confidence */
  WEBSITE_CONFIDENCE: 90,
  /** Manual alias/pattern confidence */
  ALIAS_CONFIDENCE: 90,
  /** Fuzzy name match range */
  NAME_CONFIDENCE_MIN: 60,
  NAME_CONFIDENCE_MAX: 90,
  /** AI lookup confidence (Gemini) */
  AI_LOOKUP_CONFIDENCE: 89,
};

export const PARTNER_MATCHING_AUTOMATIONS: AutomationStep[] = [
  {
    id: "partner-iban-match",
    name: "IBAN Match",
    shortDescription: "Match by bank account number",
    longDescription:
      "Matches transactions to partners based on the IBAN (bank account number) in the transaction. This is the most reliable match since IBANs are unique to each bank account.",
    icon: "Building2",
    integrationId: null,
    affectedFields: ["partnerId", "partnerType", "partnerMatchConfidence"],
    confidence: {
      min: PARTNER_MATCH_CONFIG.IBAN_CONFIDENCE,
      max: PARTNER_MATCH_CONFIG.IBAN_CONFIDENCE,
      unit: "percent"
    },
    order: 1,
    trigger: "always", // Highest priority, always checked first
    category: "matching",
    exposure: { ui: ["/transactions"], mcp: true, chat: true },
  },
  {
    id: "partner-pattern-match",
    name: "Learned Pattern Match",
    shortDescription: "Match using patterns from previous assignments",
    longDescription:
      "Uses glob patterns learned from previous manual partner assignments. When you assign a transaction to a partner, the system learns text patterns from that transaction to recognize similar ones in the future.",
    icon: "Sparkles",
    integrationId: null,
    affectedFields: ["partnerId", "partnerType", "partnerMatchConfidence", "partnerSuggestions"],
    confidence: { min: 50, max: 100, unit: "percent" },
    order: 2,
    trigger: "always", // Always checked, may produce suggestions even if IBAN matched
    category: "matching",
    exposure: { ui: ["/transactions"], mcp: true, chat: true },
  },
  {
    id: "partner-vat-match",
    name: "VAT ID Match",
    shortDescription: "Match by VAT identification number",
    longDescription:
      "Matches transactions to partners based on their VAT ID. This is highly reliable for business transactions as VAT IDs are unique and verified by tax authorities.",
    icon: "Receipt",
    integrationId: null,
    affectedFields: ["partnerId", "partnerType", "partnerMatchConfidence"],
    confidence: {
      min: PARTNER_MATCH_CONFIG.VAT_CONFIDENCE,
      max: PARTNER_MATCH_CONFIG.VAT_CONFIDENCE,
      unit: "percent"
    },
    order: 3,
    trigger: "always",
    category: "matching",
    exposure: { ui: ["/transactions"], mcp: true, chat: true },
  },
  {
    id: "partner-website-match",
    name: "Website Match",
    shortDescription: "Match by company website in transaction",
    longDescription:
      "Detects partner websites mentioned in transaction descriptions. When a transaction contains a URL that matches a known partner's website, it suggests that partner.",
    icon: "Globe",
    integrationId: null,
    affectedFields: ["partnerId", "partnerType", "partnerMatchConfidence"],
    confidence: {
      min: PARTNER_MATCH_CONFIG.WEBSITE_CONFIDENCE,
      max: PARTNER_MATCH_CONFIG.WEBSITE_CONFIDENCE,
      unit: "percent"
    },
    order: 4,
    trigger: "always",
    category: "matching",
    exposure: { ui: ["/transactions"], mcp: true, chat: true },
  },
  {
    id: "partner-alias-match",
    name: "Manual Alias Match",
    shortDescription: "Match using manually defined aliases",
    longDescription:
      "Matches transactions using glob patterns (wildcards like * and ?) that you've manually defined on partners. Useful for catching variations in how a company appears in bank statements.",
    icon: "Tag",
    integrationId: null,
    affectedFields: ["partnerId", "partnerType", "partnerMatchConfidence"],
    confidence: {
      min: PARTNER_MATCH_CONFIG.ALIAS_CONFIDENCE,
      max: PARTNER_MATCH_CONFIG.ALIAS_CONFIDENCE,
      unit: "percent"
    },
    order: 5,
    trigger: "always",
    category: "matching",
    exposure: { ui: ["/transactions", "/partners"], mcp: true, chat: true },
  },
  {
    id: "partner-fuzzy-name-match",
    name: "Fuzzy Name Match",
    shortDescription: "Match by similar company name",
    longDescription:
      "Uses fuzzy string matching to find partners with similar names. Even if the transaction text isn't an exact match, similar names (accounting for typos, abbreviations, etc.) will be suggested.",
    icon: "Search",
    integrationId: null,
    affectedFields: ["partnerId", "partnerType", "partnerMatchConfidence", "partnerSuggestions"],
    confidence: {
      min: PARTNER_MATCH_CONFIG.NAME_CONFIDENCE_MIN,
      max: PARTNER_MATCH_CONFIG.NAME_CONFIDENCE_MAX,
      unit: "percent"
    },
    order: 6,
    trigger: "always", // Always runs for suggestions
    category: "matching",
    exposure: { ui: ["/transactions"], mcp: true, chat: true },
  },
  {
    id: "partner-ai-lookup",
    name: "AI Company Lookup",
    shortDescription: "Search for company info using AI",
    longDescription:
      "When no match is found but the transaction appears to be from a real company, AI searches for company information online. If found, it can automatically create a new partner with verified details.",
    icon: "Bot",
    integrationId: null,
    affectedFields: ["partnerId", "partnerType", "partnerMatchConfidence"],
    confidence: {
      min: PARTNER_MATCH_CONFIG.AI_LOOKUP_CONFIDENCE,
      max: PARTNER_MATCH_CONFIG.AI_LOOKUP_CONFIDENCE,
      unit: "percent"
    },
    order: 7,
    trigger: "if_no_match", // Only runs when no existing partner matched
    canCreateEntities: true,
    category: "ai",
    exposure: { ui: ["/transactions"], mcp: true, chat: true },
  },
];

// ============================================================================
// CATEGORY (NO-RECEIPT) MATCHING CONFIG
// ============================================================================

/**
 * Category matching configuration
 * These values are used by category-matcher.ts (server-side)
 * Category matching steps are included in FILE_MATCHING_AUTOMATIONS below
 */
export const CATEGORY_MATCH_CONFIG = {
  /** Minimum confidence to show as suggestion */
  SUGGESTION_THRESHOLD: 60,
  /** Minimum confidence for auto-assignment */
  AUTO_APPLY_THRESHOLD: 89,
  /** Base confidence for partner-only match (at threshold to auto-apply) */
  PARTNER_MATCH_CONFIDENCE: 89,
  /** Bonus confidence when both partner and pattern match */
  COMBINED_MATCH_BONUS: 15,
  /** Maximum usage-based confidence boost (applied logarithmically) */
  USAGE_BOOST_MAX: 10,
  /** Boost when partner has no file source patterns (likely no-receipt partner) */
  NO_FILE_PATTERNS_BOOST: 8,
};

// ============================================================================
// FILE MATCHING AUTOMATIONS
// ============================================================================

export const FILE_MATCHING_AUTOMATIONS: AutomationStep[] = [
  {
    id: "file-partner-matching",
    name: "File Partner Matching",
    shortDescription: "Match uploaded files to partners",
    longDescription:
      "When a file is uploaded and extracted, automatically matches it to a partner using: " +
      "IBAN from invoice, VAT ID, partner name matching, website/email domain matching. " +
      "If no match is found but the file appears to be from a real company, AI searches for company info. " +
      `Auto-applies matches at ${PARTNER_MATCH_CONFIG.AUTO_APPLY_THRESHOLD}%+ confidence; lower scores appear as suggestions.`,
    icon: "Building2",
    integrationId: null,
    affectedFields: ["partnerId", "partnerType", "partnerMatchConfidence", "partnerSuggestions"],
    confidence: {
      min: 50,
      max: 100,
      unit: "percent"
    },
    order: 1,
    trigger: "always", // Runs on extraction complete, before transaction matching
    canCreateEntities: true, // Can create new partners via AI lookup
    category: "matching",
    exposure: { ui: ["/files"], mcp: true, chat: true },
  },
  {
    id: "file-transaction-matching",
    name: "Transaction Matching",
    shortDescription: "Match files to transactions by amount, date, and partner",
    longDescription:
      `Automatically matches uploaded receipts and invoices to transactions using a scoring algorithm. ` +
      `The system considers: invoice amount (exact or close matches), date proximity (within ${TRANSACTION_MATCH_CONFIG.DATE_RANGE_DAYS} days), ` +
      `partner overlap (same company on both), IBAN presence, and reference/invoice numbers. ` +
      `Matches scoring ${TRANSACTION_MATCH_CONFIG.AUTO_MATCH_THRESHOLD}+ points are auto-connected; ` +
      `scores ${TRANSACTION_MATCH_CONFIG.SUGGESTION_THRESHOLD}-${TRANSACTION_MATCH_CONFIG.AUTO_MATCH_THRESHOLD - 1} appear as suggestions.`,
    icon: "FileSearch",
    integrationId: null,
    affectedFields: ["fileIds"],
    confidence: {
      min: TRANSACTION_MATCH_CONFIG.SUGGESTION_THRESHOLD,
      max: 100,
      unit: "percent"
    },
    order: 2,
    trigger: "always",
    category: "matching",
    exposure: { ui: ["/transactions", "/files"], mcp: true, chat: true },
  },
  {
    id: "partner-batch-matching",
    name: "Partner Batch Matching",
    shortDescription: "Match all files and transactions for a partner at once",
    longDescription:
      "When a partner is assigned, finds all unmatched files and transactions for that partner and attempts to match them together. " +
      "Uses amount similarity, date proximity, and partner patterns for scoring. If many items remain unmatched after scoring, " +
      "AI analyzes invoice details and transaction descriptions to find matches that simple scoring might miss.",
    icon: "Layers",
    integrationId: null,
    affectedFields: ["fileIds", "transactionIds"],
    confidence: {
      min: 50,
      max: 100,
      unit: "percent"
    },
    order: 3,
    trigger: "on_partner_assign", // Runs when partner is assigned to file or transaction
    category: "matching",
    exposure: { ui: ["/transactions", "/files", "/partners"], mcp: true, chat: true },
  },
  {
    id: "file-gmail-search",
    name: "Gmail Invoice Search",
    shortDescription: "Search email attachments for invoices",
    longDescription:
      "Searches your connected Gmail account for invoice attachments based on the transaction partner and date. When you need a receipt, this automation can find PDF invoices and images from emails sent by that company around the transaction date.",
    icon: "Mail",
    integrationId: "gmail",
    affectedFields: ["fileIds"],
    order: 4,
    trigger: "if_integration",
    category: "search",
    exposure: { ui: ["/transactions", "/files"], mcp: true, chat: true },
  },
  {
    id: "file-browser-search",
    name: "Browser Invoice Collection",
    shortDescription: "Collect invoices from partner websites",
    longDescription:
      "Uses the browser extension to automatically collect invoices from partner websites. " +
      "When a partner has configured invoice sources (e.g., Amazon order history, utility company portals), " +
      "the extension can navigate to those sites and download invoice PDFs automatically.",
    icon: "Globe",
    integrationId: "browser",
    affectedFields: ["fileIds"],
    order: 5,
    trigger: "if_integration",
    category: "search",
    exposure: { ui: ["/transactions", "/files"], mcp: false, chat: false }, // Browser extension only
  },
  {
    id: "category-partner-match",
    name: "No-Receipt: Partner Match",
    shortDescription: "Match by previously categorized partner",
    longDescription:
      `When no file is found, checks if the transaction's partner was previously assigned to a no-receipt category ` +
      `(like bank fees, interest, or internal transfers). Confidence is boosted based on how often the category is used ` +
      `(up to +${CATEGORY_MATCH_CONFIG.USAGE_BOOST_MAX}) and whether the partner has file patterns ` +
      `(+${CATEGORY_MATCH_CONFIG.NO_FILE_PATTERNS_BOOST} if no file patterns, indicating likely no-receipt partner).`,
    icon: "FolderOpen",
    integrationId: null,
    affectedFields: ["noReceiptCategoryId", "categorySuggestions"],
    confidence: {
      min: CATEGORY_MATCH_CONFIG.PARTNER_MATCH_CONFIDENCE,
      max: 100, // Can reach 100 with usage + no-file-patterns boosts
      unit: "percent"
    },
    order: 6,
    trigger: "if_no_match", // Only runs if no file was matched
    category: "matching",
    exposure: { ui: ["/transactions"], mcp: true, chat: true },
  },
  {
    id: "category-pattern-match",
    name: "No-Receipt: Pattern Match",
    shortDescription: "Match using learned patterns for receipt-free transactions",
    longDescription:
      `When no file is found, uses glob patterns learned from previous no-receipt category assignments. ` +
      `Recognizes transaction text patterns like "BANK FEE*" or "INTEREST*" to suggest appropriate categories. ` +
      `Confidence is boosted based on category usage frequency (up to +${CATEGORY_MATCH_CONFIG.USAGE_BOOST_MAX}).`,
    icon: "Sparkles",
    integrationId: null,
    affectedFields: ["noReceiptCategoryId", "categorySuggestions"],
    confidence: {
      min: CATEGORY_MATCH_CONFIG.SUGGESTION_THRESHOLD,
      max: 100,
      unit: "percent"
    },
    order: 7,
    trigger: "if_no_match", // Only runs if no file was matched
    category: "matching",
    exposure: { ui: ["/transactions"], mcp: true, chat: true },
  },
];

// ============================================================================
// TRIGGER-BASED RE-MATCHING AUTOMATIONS
// These run automatically when certain events occur (not part of main pipelines)
// ============================================================================

export const TRIGGER_BASED_AUTOMATIONS: AutomationStep[] = [
  {
    id: "trigger-partner-create-rematch",
    name: "Re-match on Partner Create",
    shortDescription: "Re-evaluate unmatched transactions when a new partner is created",
    longDescription:
      "When a new partner is created, automatically re-evaluates all unmatched transactions for that user. " +
      "Uses all partner matching methods (IBAN, patterns, aliases, etc.) to find transactions that now match the new partner. " +
      `Auto-applies matches at ${PARTNER_MATCH_CONFIG.AUTO_APPLY_THRESHOLD}%+ confidence.`,
    icon: "Building2",
    integrationId: null,
    affectedFields: ["partnerId", "partnerType", "partnerMatchConfidence", "partnerSuggestions"],
    confidence: { min: 50, max: 100, unit: "percent" },
    order: 1,
    trigger: "always", // Triggered by partner creation
    category: "matching",
    exposure: { ui: [], mcp: true, chat: true }, // Automatic, no direct UI
  },
  {
    id: "trigger-category-create-rematch",
    name: "Re-match on Category Create",
    shortDescription: "Re-evaluate transactions when a new no-receipt category is created",
    longDescription:
      "When a new no-receipt category is created, automatically re-evaluates all transactions without files. " +
      "Checks if any unmatched transactions should be assigned to the new category based on partner associations or patterns. " +
      `Auto-applies at ${CATEGORY_MATCH_CONFIG.AUTO_APPLY_THRESHOLD}%+ confidence.`,
    icon: "FolderOpen",
    integrationId: null,
    affectedFields: ["noReceiptCategoryId", "categorySuggestions"],
    confidence: { min: CATEGORY_MATCH_CONFIG.SUGGESTION_THRESHOLD, max: 100, unit: "percent" },
    order: 2,
    trigger: "always", // Triggered by category creation
    category: "matching",
    exposure: { ui: [], mcp: true, chat: true }, // Automatic, no direct UI
  },
  {
    id: "trigger-partner-update-file-rematch",
    name: "Re-match Files on Partner Update",
    shortDescription: "Re-evaluate file matches when partner details change",
    longDescription:
      "When a partner's details change (name, aliases, IBAN, VAT, website, email domains), re-evaluates files: " +
      "1) Files auto-matched to this partner are checked for better matches. " +
      "2) Unmatched files are checked against the updated partner. " +
      "Manually-assigned files are never affected.",
    icon: "FileText",
    integrationId: null,
    affectedFields: ["partnerId", "partnerType", "partnerMatchConfidence"],
    confidence: { min: 50, max: 100, unit: "percent" },
    order: 3,
    trigger: "always", // Triggered by partner update
    category: "matching",
    exposure: { ui: [], mcp: true, chat: true }, // Automatic, no direct UI
  },
  {
    id: "trigger-partner-assign-category-rematch",
    name: "Re-match Category on Partner Assignment",
    shortDescription: "Re-evaluate no-receipt categories when partner is assigned to transaction",
    longDescription:
      "When a transaction gets assigned a partner, re-evaluates no-receipt categories. " +
      "If the partner has been previously associated with a no-receipt category (like bank fees), " +
      "the category may be automatically suggested or applied.",
    icon: "Tag",
    integrationId: null,
    affectedFields: ["noReceiptCategoryId", "categorySuggestions"],
    confidence: { min: CATEGORY_MATCH_CONFIG.SUGGESTION_THRESHOLD, max: 100, unit: "percent" },
    order: 4,
    trigger: "always", // Triggered by partner assignment
    category: "matching",
    exposure: { ui: [], mcp: true, chat: true }, // Automatic, no direct UI
  },
];

// ============================================================================
// PIPELINES
// ============================================================================

export const FIND_PARTNER_PIPELINE: AutomationPipeline = {
  id: "find-partner",
  name: "Find Partner for Transaction",
  description:
    `Automatically identifies which company or person a transaction belongs to. ` +
    `Matches with ${PARTNER_MATCH_CONFIG.AUTO_APPLY_THRESHOLD}%+ confidence are auto-applied; lower scores appear as suggestions.`,
  icon: "Building2",
  triggers: [
    {
      type: "on_import",
      description: "Runs when new transactions are imported from a bank account",
    },
    {
      type: "on_partner_create",
      description: "Re-evaluates unmatched transactions when a new partner is created",
    },
  ],
  steps: PARTNER_MATCHING_AUTOMATIONS,
};

export const FIND_FILE_PIPELINE: AutomationPipeline = {
  id: "find-file",
  name: "Find Receipt for Transaction",
  description:
    `Matches receipts/invoices to transactions, or suggests no-receipt categories when appropriate. ` +
    `Files auto-connect at ${TRANSACTION_MATCH_CONFIG.AUTO_MATCH_THRESHOLD}+ points; ` +
    `categories auto-apply at ${CATEGORY_MATCH_CONFIG.AUTO_APPLY_THRESHOLD}%+ confidence.`,
  icon: "FileText",
  triggers: [
    {
      type: "on_file_upload",
      description: "Runs when a new file is uploaded to find matching transactions",
    },
    {
      type: "on_extraction_complete",
      description: "Runs after AI extracts invoice details (amount, date, partner)",
    },
    {
      type: "chained",
      description: "Re-runs after partner is assigned to a transaction",
    },
  ],
  steps: FILE_MATCHING_AUTOMATIONS,
};

export const TRIGGER_BASED_PIPELINE: AutomationPipeline = {
  id: "trigger-based" as PipelineId,
  name: "Automatic Re-matching",
  description:
    "Automations that run automatically when data changes. These ensure that creating or updating " +
    "partners, categories, or other data triggers re-evaluation of related items.",
  icon: "Zap",
  triggers: [
    {
      type: "on_partner_create" as const,
      description: "Re-matches transactions when a new partner is created",
    },
    {
      type: "on_partner_update" as const,
      description: "Re-matches files when partner details change",
    },
    {
      type: "on_category_create" as const,
      description: "Re-matches transactions when a new no-receipt category is created",
    },
    {
      type: "on_transaction_update" as const,
      description: "Re-matches categories when partner is assigned to a transaction",
    },
  ],
  steps: TRIGGER_BASED_AUTOMATIONS,
};

// ============================================================================
// FILE-CENTRIC PIPELINES (from file perspective)
// ============================================================================

export const FILE_FIND_PARTNER_PIPELINE: AutomationPipeline = {
  id: "file-find-partner",
  name: "Find Partner for File",
  description:
    `Identifies which company or person an invoice/receipt belongs to. ` +
    `Uses extracted data like company name, IBAN, VAT ID, email domain to match against known partners. ` +
    `Matches with ${PARTNER_MATCH_CONFIG.AUTO_APPLY_THRESHOLD}%+ confidence are auto-applied.`,
  icon: "Building2",
  triggers: [
    {
      type: "on_extraction_complete",
      description: "Runs after invoice data is extracted from uploaded file",
    },
  ],
  // Reuse partner matching automations since the logic is similar
  steps: [
    {
      id: "file-partner-extraction",
      name: "Extract Partner Info",
      shortDescription: "Parse invoice for company/vendor information",
      longDescription:
        "Extracts company name, IBAN, VAT ID, address, email domain and other identifying information " +
        "from the uploaded invoice or receipt using AI document extraction.",
      icon: "FileText",
      integrationId: null,
      affectedFields: ["extractedPartner", "extractedVatId", "extractedIban"],
      order: 1,
      trigger: "always",
      category: "ai",
      exposure: { ui: ["/files"], mcp: true, chat: true },
    },
    ...PARTNER_MATCHING_AUTOMATIONS.slice(0, 6), // Reuse IBAN, Pattern, VAT, Website, Alias, Fuzzy matching
    {
      ...PARTNER_MATCHING_AUTOMATIONS[6], // AI Company Lookup
      longDescription:
        "When no match is found but the invoice appears to be from a real company, AI searches for company information online. " +
        "If found, it can automatically create a new partner with verified details like VAT ID and address.",
    },
  ],
};

export const FILE_FIND_TX_PIPELINE: AutomationPipeline = {
  id: "file-find-tx",
  name: "Find Transaction for File",
  description:
    `Matches an invoice/receipt to its corresponding bank transaction. ` +
    `Uses amount, date proximity, and partner overlap for scoring. ` +
    `Matches scoring ${TRANSACTION_MATCH_CONFIG.AUTO_MATCH_THRESHOLD}+ points are auto-connected.`,
  icon: "FileSearch",
  triggers: [
    {
      type: "on_extraction_complete",
      description: "Runs after invoice data is extracted from uploaded file",
    },
    {
      type: "chained",
      description: "Re-runs after partner is assigned to the file",
    },
  ],
  steps: [
    FILE_MATCHING_AUTOMATIONS[1], // file-transaction-matching
    FILE_MATCHING_AUTOMATIONS[2], // partner-batch-matching
  ],
};

export const ALL_PIPELINES: AutomationPipeline[] = [
  FIND_PARTNER_PIPELINE,
  FIND_FILE_PIPELINE,
  FILE_FIND_PARTNER_PIPELINE,
  FILE_FIND_TX_PIPELINE,
  TRIGGER_BASED_PIPELINE,
];
