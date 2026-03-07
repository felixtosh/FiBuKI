/**
 * FiBuKI OpenClaw Plugin
 *
 * Exposes FiBuKI tools as OpenClaw agent tools via the FiBuKI HTTP API.
 * Users authenticate with an API key generated in FiBuKI Settings.
 */

const API_BASE_URL = "https://fibuki.com";

// OpenClaw plugin API types
interface OpenClawApi {
  config: PluginConfig;
  logger: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };
  registerAgentTool: (tool: AgentTool) => void;
  registerService: (service: Service) => void;
}

interface PluginConfig {
  apiKey?: string;
}

interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

interface Service {
  id: string;
  start: () => void;
  stop: () => void;
}

// Tool definitions with full documentation for Claude
const TOOL_DEFINITIONS: AgentTool[] = [
  // ========== SOURCES ==========
  {
    name: "list_sources",
    description: "List all bank accounts/sources for the user. Returns account names, IBANs, types (bank_account/credit_card), and currency.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => "", // Placeholder, replaced at registration
  },
  {
    name: "get_source",
    description: "Get details of a specific bank account/source by ID.",
    inputSchema: {
      type: "object",
      properties: {
        sourceId: { type: "string", description: "The bank account/source ID" },
      },
      required: ["sourceId"],
    },
    handler: async () => "",
  },

  // ========== TRANSACTIONS ==========
  {
    name: "list_transactions",
    description:
      "List transactions with optional filters. Returns date, amount (in cents!), partner, description, completion status. Use isComplete=false to find incomplete transactions.",
    inputSchema: {
      type: "object",
      properties: {
        sourceId: { type: "string", description: "Filter by bank account ID" },
        dateFrom: { type: "string", description: "Start date (ISO format: 2024-01-01)" },
        dateTo: { type: "string", description: "End date (ISO format)" },
        search: { type: "string", description: "Search in name, description, partner" },
        isComplete: { type: "boolean", description: "Filter by completion status" },
        limit: { type: "number", description: "Max results (default 50, max 100)" },
      },
    },
    handler: async () => "",
  },
  {
    name: "get_transaction",
    description: "Get full details of a specific transaction including partner suggestions and file attachments.",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: { type: "string", description: "The transaction ID" },
      },
      required: ["transactionId"],
    },
    handler: async () => "",
  },
  {
    name: "update_transaction",
    description: "Update a transaction's description or completion status. Use for adding tax-relevant notes.",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: { type: "string", description: "The transaction ID" },
        description: { type: "string", description: "Description for tax purposes" },
        isComplete: { type: "boolean", description: "Mark as complete/incomplete" },
      },
      required: ["transactionId"],
    },
    handler: async () => "",
  },

  // ========== FILES ==========
  {
    name: "list_files",
    description:
      "List uploaded files (receipts/invoices) with match suggestions. Files have transactionSuggestions with confidence scores. Use hasConnections=false to find unmatched files.",
    inputSchema: {
      type: "object",
      properties: {
        hasConnections: { type: "boolean", description: "true = matched files, false = unmatched" },
        hasSuggestions: { type: "boolean", description: "Filter by whether file has transaction suggestions" },
        limit: { type: "number", description: "Max results (default 50)" },
      },
    },
    handler: async () => "",
  },
  {
    name: "get_file",
    description: "Get full details of a file including extracted data (amount, date, partner) and transaction suggestions.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file ID" },
      },
      required: ["fileId"],
    },
    handler: async () => "",
  },
  {
    name: "connect_file_to_transaction",
    description:
      "Connect a file (receipt) to a transaction. This marks the transaction as complete. Use when you've confirmed a file matches a transaction.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file ID to connect" },
        transactionId: { type: "string", description: "The transaction ID to connect to" },
      },
      required: ["fileId", "transactionId"],
    },
    handler: async () => "",
  },
  {
    name: "disconnect_file_from_transaction",
    description: "Disconnect a file from a transaction. Use when a match was incorrect.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file ID" },
        transactionId: { type: "string", description: "The transaction ID" },
      },
      required: ["fileId", "transactionId"],
    },
    handler: async () => "",
  },
  {
    name: "list_transactions_needing_files",
    description:
      "Find transactions without receipts (no files connected AND no no-receipt category). These need action.",
    inputSchema: {
      type: "object",
      properties: {
        minAmount: { type: "number", description: "Minimum amount in cents (absolute value)" },
        limit: { type: "number", description: "Max results (default 50)" },
      },
    },
    handler: async () => "",
  },
  {
    name: "auto_connect_file_suggestions",
    description:
      "Automatically connect files to transactions where suggestion confidence is above threshold. Great for bulk matching. Default threshold is 89%.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Specific file ID, or omit for all unmatched files" },
        minConfidence: { type: "number", description: "Minimum confidence 0-100 (default 89)" },
      },
    },
    handler: async () => "",
  },

  // ========== CATEGORIES ==========
  {
    name: "list_no_receipt_categories",
    description:
      "List categories for transactions that don't need receipts: Bank fees, Interest, Internal transfers, Payroll, Taxes, etc.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => "",
  },
  {
    name: "assign_no_receipt_category",
    description:
      "Assign a no-receipt category to a transaction. This marks it complete without needing a file. Use for bank fees, interest, internal transfers, etc.",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: { type: "string", description: "The transaction ID" },
        categoryId: { type: "string", description: "The category ID to assign" },
      },
      required: ["transactionId", "categoryId"],
    },
    handler: async () => "",
  },
  {
    name: "remove_no_receipt_category",
    description: "Remove a no-receipt category from a transaction.",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: { type: "string", description: "The transaction ID" },
      },
      required: ["transactionId"],
    },
    handler: async () => "",
  },
];

/**
 * Call the FiBuKI MCP API
 */
async function callApi(
  apiKey: string,
  tool: string,
  args: Record<string, unknown>
): Promise<string> {
  const response = await fetch(`${API_BASE_URL}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ tool, arguments: args }),
  });

  const data = await response.json();

  if (!response.ok || !data.success) {
    throw new Error(data.error || `API error: ${response.status}`);
  }

  return JSON.stringify(data.result, null, 2);
}

/**
 * Main plugin registration function
 */
export default function register(api: OpenClawApi) {
  const { config, logger } = api;

  // Validate required config — check plugin config first, then env var
  const apiKey = config.apiKey || process.env.FIBUKI_API_KEY;
  if (!apiKey) {
    logger.error("FiBuKI plugin requires an API key. Set FIBUKI_API_KEY env var, or add apiKey to plugin config. Generate one at fibuki.com > Settings > Integrations, or run: npx @fibukiapp/cli auth");
    return;
  }
  logger.info("FiBuKI plugin initializing...");

  // Register all tools
  for (const toolDef of TOOL_DEFINITIONS) {
    api.registerAgentTool({
      name: toolDef.name,
      description: toolDef.description,
      inputSchema: toolDef.inputSchema,
      handler: async (args) => {
        try {
          return await callApi(apiKey, toolDef.name, args);
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Unknown error";
          return `Error: ${msg}`;
        }
      },
    });
    logger.debug(`Registered tool: ${toolDef.name}`);
  }

  logger.info(`FiBuKI plugin loaded with ${TOOL_DEFINITIONS.length} tools`);
}

// Export plugin metadata
export const id = "fibuki";
export const name = "FiBuKI Tax Studio";
