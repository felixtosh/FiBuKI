/**
 * MCP Automation Tools
 *
 * @deprecated The automation definitions in this file are deprecated.
 *
 * NEW APPROACH:
 * - Automation metadata is now defined in functions/src/matching/*.ts (co-located with triggers)
 * - Use the generated file: import { AUTOMATIONS } from "../generated/automations.js"
 * - To regenerate: npm run generate:mcp-automations (from root)
 *
 * The duplicated definitions below are kept for backward compatibility but
 * should be replaced with imports from the generated file.
 *
 * ============================================================================
 * LEGACY DEFINITIONS - TO BE REMOVED
 * ============================================================================
 */

import { z } from "zod";
import { doc, getDoc } from "firebase/firestore";
import { OperationsContext } from "../types.js";
import { Tool } from "@modelcontextprotocol/sdk/types.js";

const TRANSACTIONS_COLLECTION = "transactions";

// Config values - keep in sync with /lib/matching/automation-defs.ts
const PARTNER_MATCH_CONFIG = {
  AUTO_APPLY_THRESHOLD: 89,
  IBAN_CONFIDENCE: 100,
  VAT_CONFIDENCE: 95,
  WEBSITE_CONFIDENCE: 90,
  ALIAS_CONFIDENCE: 90,
  NAME_CONFIDENCE_MIN: 60,
  NAME_CONFIDENCE_MAX: 90,
  AI_LOOKUP_CONFIDENCE: 89,
};

/**
 * Automation step definition (mirrors types/automation.ts)
 */
/**
 * When a step runs within its pipeline
 */
type AutomationTrigger = "always" | "if_no_match" | "if_integration" | "manual";

/**
 * What events trigger a pipeline
 */
type PipelineTrigger = "on_import" | "on_partner_create" | "on_partner_update" | "on_file_upload" | "on_extraction_complete" | "on_category_create" | "on_transaction_update" | "chained" | "manual";

interface AutomationStep {
  id: string;
  name: string;
  shortDescription: string;
  longDescription: string;
  icon: string;
  integrationId: string | null;
  affectedFields: string[];
  confidence?: { min: number; max: number; unit: "percent" | "points" };
  order: number;
  trigger: AutomationTrigger;
  canCreateEntities?: boolean;
  category: "matching" | "search" | "ai" | "scoring";
}

interface AutomationPipeline {
  id: "find-partner" | "find-file" | "trigger-based";
  name: string;
  description: string;
  icon: string;
  triggers: { type: PipelineTrigger; description: string }[];
  steps: AutomationStep[];
}

/**
 * Partner Matching Pipeline Steps
 */
const PARTNER_MATCHING_STEPS: AutomationStep[] = [
  {
    id: "partner-iban-match",
    name: "IBAN Match",
    shortDescription: "Match by bank account number",
    longDescription:
      "Matches transactions to partners based on the IBAN (bank account number) in the transaction. This is the most reliable match since IBANs are unique to each bank account.",
    icon: "Building2",
    integrationId: null,
    affectedFields: ["partnerId", "partnerType", "partnerMatchConfidence"],
    confidence: { min: PARTNER_MATCH_CONFIG.IBAN_CONFIDENCE, max: PARTNER_MATCH_CONFIG.IBAN_CONFIDENCE, unit: "percent" },
    order: 1,
    trigger: "always",
    category: "matching",
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
    trigger: "always",
    category: "matching",
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
    confidence: { min: PARTNER_MATCH_CONFIG.VAT_CONFIDENCE, max: PARTNER_MATCH_CONFIG.VAT_CONFIDENCE, unit: "percent" },
    order: 3,
    trigger: "always",
    category: "matching",
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
    confidence: { min: PARTNER_MATCH_CONFIG.WEBSITE_CONFIDENCE, max: PARTNER_MATCH_CONFIG.WEBSITE_CONFIDENCE, unit: "percent" },
    order: 4,
    trigger: "always",
    category: "matching",
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
    confidence: { min: PARTNER_MATCH_CONFIG.ALIAS_CONFIDENCE, max: PARTNER_MATCH_CONFIG.ALIAS_CONFIDENCE, unit: "percent" },
    order: 5,
    trigger: "always",
    category: "matching",
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
    confidence: { min: PARTNER_MATCH_CONFIG.NAME_CONFIDENCE_MIN, max: PARTNER_MATCH_CONFIG.NAME_CONFIDENCE_MAX, unit: "percent" },
    order: 6,
    trigger: "always",
    category: "matching",
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
    confidence: { min: PARTNER_MATCH_CONFIG.AI_LOOKUP_CONFIDENCE, max: PARTNER_MATCH_CONFIG.AI_LOOKUP_CONFIDENCE, unit: "percent" },
    order: 7,
    trigger: "if_no_match",
    canCreateEntities: true,
    category: "ai",
  },
];

// Config values - keep in sync with /lib/matching/transaction-matcher.ts
const TRANSACTION_MATCH_CONFIG = {
  AUTO_MATCH_THRESHOLD: 85,
  SUGGESTION_THRESHOLD: 50,
  DATE_RANGE_DAYS: 30,
};

// Config values - keep in sync with /lib/matching/automation-defs.ts (CATEGORY_MATCH_CONFIG)
const CATEGORY_MATCH_CONFIG = {
  SUGGESTION_THRESHOLD: 60,
  AUTO_APPLY_THRESHOLD: 89,
  PARTNER_MATCH_CONFIDENCE: 85,
  COMBINED_MATCH_BONUS: 15,
};

/**
 * File Matching Pipeline Steps
 */
const FILE_MATCHING_STEPS: AutomationStep[] = [
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
    confidence: { min: 50, max: 100, unit: "percent" },
    order: 1,
    trigger: "always",
    canCreateEntities: true,
    category: "matching",
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
    confidence: { min: TRANSACTION_MATCH_CONFIG.SUGGESTION_THRESHOLD, max: 100, unit: "percent" },
    order: 2,
    trigger: "always",
    category: "matching",
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
    order: 3,
    trigger: "if_integration",
    category: "search",
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
    order: 4,
    trigger: "if_integration",
    category: "search",
  },
  {
    id: "category-partner-match",
    name: "No-Receipt: Partner Match",
    shortDescription: "Match by previously categorized partner",
    longDescription:
      `When no file is found, checks if the transaction's partner was previously assigned to a no-receipt category ` +
      `(like bank fees, interest, or internal transfers). Useful for recurring charges that never have receipts.`,
    icon: "FolderOpen",
    integrationId: null,
    affectedFields: ["noReceiptCategoryId", "categorySuggestions"],
    confidence: { min: CATEGORY_MATCH_CONFIG.PARTNER_MATCH_CONFIDENCE, max: CATEGORY_MATCH_CONFIG.PARTNER_MATCH_CONFIDENCE, unit: "percent" },
    order: 5,
    trigger: "if_no_match",
    category: "matching",
  },
  {
    id: "category-pattern-match",
    name: "No-Receipt: Pattern Match",
    shortDescription: "Match using learned patterns for receipt-free transactions",
    longDescription:
      `When no file is found, uses glob patterns learned from previous no-receipt category assignments. ` +
      `Recognizes transaction text patterns like "BANK FEE*" or "INTEREST*" to suggest appropriate categories.`,
    icon: "Sparkles",
    integrationId: null,
    affectedFields: ["noReceiptCategoryId", "categorySuggestions"],
    confidence: { min: CATEGORY_MATCH_CONFIG.SUGGESTION_THRESHOLD, max: 100, unit: "percent" },
    order: 6,
    trigger: "if_no_match",
    category: "matching",
  },
];

/**
 * Trigger-based Re-matching Automations
 */
const TRIGGER_BASED_STEPS: AutomationStep[] = [
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
    trigger: "always",
    category: "matching",
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
    trigger: "always",
    category: "matching",
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
    trigger: "always",
    category: "matching",
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
    trigger: "always",
    category: "matching",
  },
];

/**
 * All registered pipelines
 */
const AUTOMATION_PIPELINES: AutomationPipeline[] = [
  {
    id: "find-partner",
    name: "Find Partner for Transaction",
    description:
      "Automatically identifies which company or person a transaction belongs to based on bank account details, transaction text, learned patterns, and AI lookup.",
    icon: "Building2",
    triggers: [
      { type: "on_import", description: "Runs when new transactions are imported from a bank account" },
      { type: "on_partner_create", description: "Re-evaluates unmatched transactions when a new partner is created" },
    ],
    steps: PARTNER_MATCHING_STEPS,
  },
  {
    id: "find-file",
    name: "Find Receipt for Transaction",
    description:
      `Matches receipts/invoices to transactions, or suggests no-receipt categories when appropriate. Files auto-connect at ${TRANSACTION_MATCH_CONFIG.AUTO_MATCH_THRESHOLD}+ points; categories auto-apply at ${CATEGORY_MATCH_CONFIG.AUTO_APPLY_THRESHOLD}%+ confidence.`,
    icon: "FileText",
    triggers: [
      { type: "on_file_upload", description: "Runs when a new file is uploaded to find matching transactions" },
      { type: "on_extraction_complete", description: "Runs after AI extracts invoice details (amount, date, partner)" },
      { type: "chained", description: "Re-runs after partner is assigned to a transaction" },
    ],
    steps: FILE_MATCHING_STEPS,
  },
  {
    id: "trigger-based",
    name: "Automatic Re-matching",
    description:
      "Automations that run automatically when data changes. These ensure that creating or updating " +
      "partners, categories, or other data triggers re-evaluation of related items.",
    icon: "Zap",
    triggers: [
      { type: "on_partner_create", description: "Re-matches transactions when a new partner is created" },
      { type: "on_partner_update", description: "Re-matches files when partner details change" },
      { type: "on_category_create", description: "Re-matches transactions when a new no-receipt category is created" },
      { type: "on_transaction_update", description: "Re-matches categories when partner is assigned to a transaction" },
    ],
    steps: TRIGGER_BASED_STEPS,
  },
];

// Input schemas
const listAutomationsSchema = z.object({
  pipelineId: z
    .enum(["find-partner", "find-file", "trigger-based"])
    .optional()
    .describe("Optional: filter to a specific pipeline"),
});

const getAutomationStepSchema = z.object({
  stepId: z.string().describe("The automation step ID"),
});

const explainTransactionAutomationSchema = z.object({
  transactionId: z.string().describe("The transaction ID to explain automations for"),
});

// Tool definitions
export const automationToolDefinitions: Tool[] = [
  {
    name: "list_automations",
    description:
      "List all automation pipelines and their steps. Use this to explain how transactions are matched to partners and receipts (files or no-receipt categories). Each pipeline shows the steps that run in order, their confidence levels, and which integrations they require.",
    inputSchema: {
      type: "object",
      properties: {
        pipelineId: {
          type: "string",
          enum: ["find-partner", "find-file", "trigger-based"],
          description: "Optional: filter to a specific pipeline",
        },
      },
    },
  },
  {
    name: "get_automation_step",
    description: "Get detailed information about a specific automation step, including how it works and what fields it affects.",
    inputSchema: {
      type: "object",
      properties: {
        stepId: { type: "string", description: "The automation step ID" },
      },
      required: ["stepId"],
    },
  },
  {
    name: "explain_automation_for_transaction",
    description:
      "Explain which automations were applied to a specific transaction and their results. Shows what partner matching and file matching steps ran and what they found.",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: { type: "string", description: "The transaction ID" },
      },
      required: ["transactionId"],
    },
  },
];

// Helper functions
function getPipelineById(id: string): AutomationPipeline | undefined {
  return AUTOMATION_PIPELINES.find((p) => p.id === id);
}

function getStepById(stepId: string): AutomationStep | undefined {
  for (const pipeline of AUTOMATION_PIPELINES) {
    const step = pipeline.steps.find((s) => s.id === stepId);
    if (step) return step;
  }
  return undefined;
}

// Tool handlers
export async function registerAutomationTools(
  ctx: OperationsContext,
  toolName: string,
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }> } | null> {
  switch (toolName) {
    case "list_automations": {
      const { pipelineId } = listAutomationsSchema.parse(args);

      let pipelines = AUTOMATION_PIPELINES;
      if (pipelineId) {
        const pipeline = getPipelineById(pipelineId);
        pipelines = pipeline ? [pipeline] : [];
      }

      if (pipelines.length === 0) {
        return {
          content: [{ type: "text", text: `Pipeline "${pipelineId}" not found` }],
        };
      }

      // Format output for readability
      const output = pipelines.map((pipeline) => ({
        id: pipeline.id,
        name: pipeline.name,
        description: pipeline.description,
        triggers: pipeline.triggers,
        steps: pipeline.steps.map((step) => ({
          order: step.order,
          id: step.id,
          name: step.name,
          description: step.shortDescription,
          trigger: step.trigger,
          confidence: step.confidence
            ? `${step.confidence.min}-${step.confidence.max}${step.confidence.unit === "percent" ? "%" : " pts"}`
            : null,
          integration: step.integrationId || "system",
          affectedFields: step.affectedFields,
        })),
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    }

    case "get_automation_step": {
      const { stepId } = getAutomationStepSchema.parse(args);

      const step = getStepById(stepId);
      if (!step) {
        return {
          content: [{ type: "text", text: `Step "${stepId}" not found` }],
        };
      }

      // Find which pipeline this step belongs to
      const pipeline = AUTOMATION_PIPELINES.find((p) =>
        p.steps.some((s) => s.id === stepId)
      );

      const output = {
        id: step.id,
        name: step.name,
        pipeline: pipeline?.name || "Unknown",
        shortDescription: step.shortDescription,
        longDescription: step.longDescription,
        icon: step.icon,
        trigger: step.trigger,
        integration: step.integrationId || "system",
        affectedFields: step.affectedFields,
        confidence: step.confidence || null,
        executionOrder: step.order,
        canCreateEntities: step.canCreateEntities || false,
        category: step.category,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    }

    case "explain_automation_for_transaction": {
      const { transactionId } = explainTransactionAutomationSchema.parse(args);

      // Get the transaction
      const txDoc = doc(ctx.db, TRANSACTIONS_COLLECTION, transactionId);
      const txSnapshot = await getDoc(txDoc);

      if (!txSnapshot.exists() || txSnapshot.data().userId !== ctx.userId) {
        return {
          content: [{ type: "text", text: `Transaction ${transactionId} not found` }],
        };
      }

      const tx = txSnapshot.data();

      // Build explanation
      const explanation: Record<string, unknown> = {
        transactionId,
        transactionName: tx.name || tx.partner || "Unknown",
        transactionDate: tx.date?.toDate?.()?.toISOString?.() || null,
        amount: tx.amount ? `${(tx.amount / 100).toFixed(2)} ${tx.currency || "EUR"}` : null,
      };

      // Partner automation results
      explanation.partnerAutomation = {
        hasPartner: !!tx.partnerId,
        partnerId: tx.partnerId || null,
        partnerType: tx.partnerType || null,
        matchedBy: tx.partnerMatchedBy || null,
        confidence: tx.partnerMatchConfidence || null,
        isAutoApplied: tx.partnerMatchedBy === "auto",
        suggestionsCount: tx.partnerSuggestions?.length || 0,
        topSuggestions:
          tx.partnerSuggestions?.slice(0, 3).map((s: { partnerId: string; partnerType: string; confidence: number }) => ({
            partnerId: s.partnerId,
            partnerType: s.partnerType,
            confidence: s.confidence,
          })) || [],
      };

      // File automation results
      explanation.fileAutomation = {
        hasFiles: !!(tx.fileIds && tx.fileIds.length > 0),
        connectedFileCount: tx.fileIds?.length || 0,
        fileIds: tx.fileIds || [],
      };

      // Category automation results
      explanation.categoryAutomation = {
        hasCategory: !!tx.noReceiptCategoryId,
        categoryId: tx.noReceiptCategoryId || null,
        templateId: tx.noReceiptCategoryTemplateId || null,
        matchedBy: tx.noReceiptCategoryMatchedBy || null,
        confidence: tx.noReceiptCategoryConfidence || null,
        suggestionsCount: tx.categorySuggestions?.length || 0,
      };

      // Overall status
      explanation.status = {
        isComplete: tx.isComplete || false,
        hasPartner: !!tx.partnerId,
        hasFileOrCategory:
          (tx.fileIds && tx.fileIds.length > 0) || !!tx.noReceiptCategoryId,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(explanation, null, 2) }],
      };
    }

    default:
      return null;
  }
}
