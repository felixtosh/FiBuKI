/**
 * Centralized Tool Definitions
 *
 * Single source of truth for all MCP/API tool schemas.
 * Consumed by:
 * - handlers.ts (ToolName type + dispatch)
 * - mcp-sse.ts (MCP protocol tool listing)
 * - mcp-api/index.ts (REST API tool listing)
 */

import type { PlanFeatureKey } from "../billing/config";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** If set, tool is only available when user's plan has this feature enabled */
  requiredFeature?: PlanFeatureKey;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // =========================================================================
  // Sources
  // =========================================================================
  {
    name: "list_sources",
    description: "List all bank accounts/sources for the user",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_source",
    description: "Get details of a specific bank account by ID",
    inputSchema: {
      type: "object",
      properties: { sourceId: { type: "string", description: "The bank account ID" } },
      required: ["sourceId"],
    },
  },
  {
    name: "create_source",
    description: "Create a new bank account/source",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the bank account" },
        accountKind: {
          type: "string",
          enum: ["bank_account", "credit_card"],
          description: "Type of account (default: bank_account)",
        },
        iban: { type: "string", description: "IBAN (optional)" },
        currency: { type: "string", description: "Currency code (default: EUR)" },
      },
      required: ["name"],
    },
  },
  {
    name: "delete_source",
    description: "Delete a bank account and all associated imports/transactions (cascade). Requires confirm: true.",
    inputSchema: {
      type: "object",
      properties: {
        sourceId: { type: "string", description: "The bank account ID to delete" },
        confirm: { type: "boolean", description: "Must be true to confirm deletion" },
      },
      required: ["sourceId", "confirm"],
    },
  },

  // =========================================================================
  // Transactions
  // =========================================================================
  {
    name: "list_transactions",
    description: "List transactions with optional filters. Returns date, amount (cents), partner, completion status.",
    inputSchema: {
      type: "object",
      properties: {
        sourceId: { type: "string", description: "Filter by bank account ID" },
        dateFrom: { type: "string", description: "Start date (ISO format)" },
        dateTo: { type: "string", description: "End date (ISO format)" },
        search: { type: "string", description: "Search in name, description, partner" },
        isComplete: { type: "boolean", description: "Filter by completion status" },
        limit: { type: "number", description: "Max results (default 50, max 100)" },
      },
    },
  },
  {
    name: "get_transaction",
    description: "Get full details of a transaction by ID",
    inputSchema: {
      type: "object",
      properties: { transactionId: { type: "string", description: "The transaction ID" } },
      required: ["transactionId"],
    },
  },
  {
    name: "update_transaction",
    description: "Update a transaction's description or completion status",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: { type: "string", description: "The transaction ID" },
        description: { type: "string", description: "Description for tax purposes" },
        isComplete: { type: "boolean", description: "Mark as complete/incomplete" },
      },
      required: ["transactionId"],
    },
  },
  {
    name: "list_transactions_needing_files",
    description: "Find transactions without receipts (no files, no category)",
    inputSchema: {
      type: "object",
      properties: {
        minAmount: { type: "number", description: "Minimum amount in cents" },
        limit: { type: "number", description: "Max results (default 50)" },
      },
    },
  },
  {
    name: "import_transactions",
    description: "Import pre-mapped transactions into a source. Transactions must include date, amount, name, and currency.",
    inputSchema: {
      type: "object",
      properties: {
        sourceId: { type: "string", description: "The source/bank account ID to import into" },
        transactions: {
          type: "array",
          description: "Array of transaction objects",
          items: {
            type: "object",
            properties: {
              date: { type: "string", description: "Transaction date (ISO format)" },
              amount: { type: "number", description: "Amount in cents (negative for expenses)" },
              currency: { type: "string", description: "Currency code (e.g. EUR)" },
              name: { type: "string", description: "Transaction name/payee" },
              description: { type: "string", description: "Optional description" },
              partner: { type: "string", description: "Optional partner/counterparty name" },
              reference: { type: "string", description: "Optional reference number" },
              partnerIban: { type: "string", description: "Optional partner IBAN" },
            },
            required: ["date", "amount", "currency", "name"],
          },
        },
      },
      required: ["sourceId", "transactions"],
    },
  },

  // =========================================================================
  // Files
  // =========================================================================
  {
    name: "list_files",
    description: "List uploaded files (receipts/invoices) with match suggestions",
    inputSchema: {
      type: "object",
      properties: {
        hasConnections: { type: "boolean", description: "true = matched, false = unmatched" },
        hasSuggestions: { type: "boolean", description: "Filter by suggestion availability" },
        limit: { type: "number", description: "Max results (default 50)" },
      },
    },
  },
  {
    name: "get_file",
    description: "Get file details including extracted data and suggestions",
    inputSchema: {
      type: "object",
      properties: { fileId: { type: "string", description: "The file ID" } },
      required: ["fileId"],
    },
  },
  {
    name: "connect_file_to_transaction",
    description: "Connect a file (receipt) to a transaction, marking it complete",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file ID" },
        transactionId: { type: "string", description: "The transaction ID" },
      },
      required: ["fileId", "transactionId"],
    },
  },
  {
    name: "disconnect_file_from_transaction",
    description: "Disconnect a file from a transaction",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file ID" },
        transactionId: { type: "string", description: "The transaction ID" },
      },
      required: ["fileId", "transactionId"],
    },
  },
  {
    name: "auto_connect_file_suggestions",
    description: "Auto-connect files to transactions above confidence threshold",
    requiredFeature: "aiMatching",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Specific file ID (optional)" },
        minConfidence: { type: "number", description: "Min confidence 0-100 (default 89)" },
      },
    },
  },
  {
    name: "upload_file",
    description: "Upload a file from a URL or base64 data",
    requiredFeature: "fileUpload",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to download file from" },
        base64: { type: "string", description: "Base64-encoded file content (alternative to url)" },
        fileName: { type: "string", description: "File name with extension" },
        mimeType: { type: "string", description: "MIME type (e.g. application/pdf, image/jpeg)" },
      },
      required: ["fileName", "mimeType"],
    },
  },
  {
    name: "score_file_transaction_match",
    description: "Score how well a file matches a transaction (0-100 confidence)",
    requiredFeature: "aiMatching",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file ID" },
        transactionId: { type: "string", description: "The transaction ID" },
      },
      required: ["fileId", "transactionId"],
    },
  },

  // =========================================================================
  // Partners
  // =========================================================================
  {
    name: "list_partners",
    description: "List user partners with optional search",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Search in partner name and aliases" },
        limit: { type: "number", description: "Max results (default 50, max 100)" },
      },
    },
  },
  {
    name: "get_partner",
    description: "Get partner details by ID",
    inputSchema: {
      type: "object",
      properties: { partnerId: { type: "string", description: "The partner ID" } },
      required: ["partnerId"],
    },
  },
  {
    name: "create_partner",
    description: "Create a new user partner for transaction matching",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Partner/company name" },
        aliases: { type: "array", items: { type: "string" }, description: "Alternative names" },
        vatId: { type: "string", description: "VAT ID (e.g. ATU12345678)" },
        ibans: { type: "array", items: { type: "string" }, description: "Partner IBANs" },
        website: { type: "string", description: "Partner website" },
        country: { type: "string", description: "Country code (e.g. AT, DE)" },
      },
      required: ["name"],
    },
  },
  {
    name: "assign_partner_to_transaction",
    description: "Assign a partner to a transaction for categorization",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: { type: "string", description: "The transaction ID" },
        partnerId: { type: "string", description: "The partner ID" },
      },
      required: ["transactionId", "partnerId"],
    },
  },
  {
    name: "remove_partner_from_transaction",
    description: "Remove a partner assignment from a transaction",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: { type: "string", description: "The transaction ID" },
      },
      required: ["transactionId"],
    },
  },

  // =========================================================================
  // Categories
  // =========================================================================
  {
    name: "list_no_receipt_categories",
    description: "List categories for transactions that don't need receipts",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "assign_no_receipt_category",
    description: "Assign a no-receipt category to a transaction",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: { type: "string", description: "The transaction ID" },
        categoryId: { type: "string", description: "The category ID" },
      },
      required: ["transactionId", "categoryId"],
    },
  },
  {
    name: "remove_no_receipt_category",
    description: "Remove a no-receipt category from a transaction",
    inputSchema: {
      type: "object",
      properties: { transactionId: { type: "string", description: "The transaction ID" } },
      required: ["transactionId"],
    },
  },

  // =========================================================================
  // Status
  // =========================================================================
  {
    name: "get_automation_status",
    description: "Get user's automation mode, AI budget, and plan info",
    inputSchema: { type: "object", properties: {} },
  },
];

/** All valid tool names derived from definitions */
export type ToolName = (typeof TOOL_DEFINITIONS)[number]["name"];

/** Array of all tool names for validation */
export const TOOL_NAMES: string[] = TOOL_DEFINITIONS.map((t) => t.name);
