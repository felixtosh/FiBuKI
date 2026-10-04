/**
 * Chat tools with an MCP twin (#616).
 *
 * Each is a thin wrapper over the backend's `runTool` callable, which runs the
 * named MCP tool through the same handler MCP and the REST API use, as the
 * session's User. So there is one implementation of each: filtering,
 * validation and every computed figure live in the shared tool, and the chat
 * sees exactly what an external integration sees. The MCP output shape is the
 * contract; a wrapper passes it through unchanged.
 *
 * The parameters come from the MCP definition (lib/data/generated-tool-definitions.ts),
 * so a parameter added there reaches the chat without a second edit. Only the
 * description and the default page size are the chat's own.
 *
 * Nothing in this file touches the database; the guard in
 * functions/src/selfhost/chat-mcp-tools.test.ts fails if it does.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { callFirebaseFunction } from "@/lib/api/firebase-callable";
import { TOOL_DEFINITIONS } from "@/lib/data/generated-tool-definitions";

/** Chat tool name -> the MCP tool it wraps. */
export const MCP_TWINS = {
  listSources: "list_sources",
  getSource: "get_source",
  listTransactions: "list_transactions",
  getTransaction: "get_transaction",
  updateTransaction: "update_transaction",
  createSource: "create_source",
  listFiles: "list_files",
  getFile: "get_file",
  listPartners: "list_partners",
  getPartner: "get_partner",
  listCategories: "list_no_receipt_categories",
} as const;

type ChatTwin = keyof typeof MCP_TWINS;

interface ToolConfig {
  configurable?: { authHeader?: string };
}

/**
 * The message of a failed callable call. The HTTP client reports
 * `... failed: <status> - <body>`, and the body is `{ error: { message } }`:
 * the tool's own message, the one MCP returns for the same call.
 */
export function callableErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const body = message.indexOf(" - {");
  if (body >= 0) {
    try {
      const parsed = JSON.parse(message.slice(body + 3)) as { error?: { message?: unknown } };
      if (typeof parsed?.error?.message === "string" && parsed.error.message) return parsed.error.message;
    } catch {
      /* not a callable error body: the message as it came */
    }
  }
  return message || "Tool failed";
}

/** Run one MCP tool as the session's User. A failure is returned, not thrown, as every chat tool does. */
export async function runMcpTool(
  name: string,
  args: Record<string, unknown>,
  config?: ToolConfig
): Promise<unknown> {
  const authHeader = config?.configurable?.authHeader;
  if (!authHeader) return { error: "Auth header not provided" };
  const defined = Object.fromEntries(Object.entries(args ?? {}).filter(([, v]) => v !== undefined));
  try {
    const result = await callFirebaseFunction<{ tool: string; arguments: Record<string, unknown> }, unknown>(
      "runTool",
      { tool: name, arguments: defined },
      authHeader
    );
    // LangChain stringifies an object result for the model, but reads an
    // array whose items all have a `type` key as message content blocks, and
    // a bank account record has `type: "manual"`. The same JSON, as text.
    return Array.isArray(result) ? JSON.stringify(result) : result;
  } catch (err) {
    return { error: callableErrorMessage(err) };
  }
}

// ============================================================================
// Parameters, from the MCP definition
// ============================================================================

type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  items?: JsonSchema;
  description?: string;
};

function fromJsonSchema(schema: JsonSchema): z.ZodTypeAny {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const nullable = types.includes("null");
  const base = types.find((t) => t !== "null");
  let out: z.ZodTypeAny;
  const values = (schema.enum ?? []).filter((v): v is string => typeof v === "string");
  if (base === "string" && values.length > 0) out = z.enum(values as [string, ...string[]]);
  else if (base === "string") out = z.string();
  else if (base === "number" || base === "integer") out = z.number();
  else if (base === "boolean") out = z.boolean();
  else if (base === "array") out = z.array(schema.items ? fromJsonSchema(schema.items) : z.unknown());
  else if (base === "object") out = z.record(z.string(), z.unknown());
  else out = z.unknown();
  if (nullable) out = out.nullable();
  return schema.description ? out.describe(schema.description) : out;
}

/**
 * The chat tool's parameters: the MCP tool's, or the `pick`ed ones of them
 * (a write the chat exposes only in part), with `overrides` for what the
 * chat words differently.
 */
function mcpSchema(
  mcpName: string,
  options: { pick?: string[]; overrides?: Record<string, z.ZodTypeAny> } = {}
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const def = TOOL_DEFINITIONS.find((t) => t.name === mcpName);
  if (!def) throw new Error(`No MCP tool ${mcpName}`);
  const required = new Set(def.inputSchema.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(def.inputSchema.properties)) {
    if (options.pick && !options.pick.includes(key)) continue;
    const field = fromJsonSchema(prop as JsonSchema);
    shape[key] = required.has(key) ? field : field.optional();
  }
  Object.assign(shape, options.overrides ?? {});
  return z.object(shape);
}

/** The chat's page size: the MCP default of 50 rows is a lot of context. */
const chatLimit = z.number().optional().default(20).describe("Max results per page (default 20, max 500)");

function wrap(
  chatName: ChatTwin,
  description: string,
  schema: z.ZodObject<Record<string, z.ZodTypeAny>>
) {
  const mcpName = MCP_TWINS[chatName];
  return tool(
    async (args: Record<string, unknown>, config?: ToolConfig) => runMcpTool(mcpName, args, config),
    { name: chatName, description, schema }
  );
}

// ============================================================================
// The wrappers
// ============================================================================

export const listSourcesTool = wrap(
  "listSources",
  "List the user's bank accounts (sources). Returns an array of accounts with id, name, iban, currency, isActive.",
  mcpSchema("list_sources")
);

export const getSourceTool = wrap(
  "getSource",
  "Get details of a single bank account by ID.",
  mcpSchema("get_source")
);

export const listTransactionsTool = wrap(
  "listTransactions",
  "List transactions with optional filters. Amounts are integer cents (negative = expense); dates are YYYY-MM-DD. " +
    "Use exploratory filters (search + hasPartner/hasNoReceiptCategory/hasFile + onlyIncome/onlyExpenses) to find " +
    "transactions matching a fuzzy intent before acting. Returns transactions, total (matches in the scanned window), " +
    "aggregates (counts by partner/file/no-receipt-category presence) and nextCursor. If scanTruncated is true the " +
    "answer is partial: say so rather than reporting it as a total.",
  mcpSchema("list_transactions", { overrides: { limit: chatLimit } })
);

export const getTransactionTool = wrap(
  "getTransaction",
  "Get full details of a single transaction by ID. Amounts are integer cents.",
  mcpSchema("get_transaction")
);

export const listFilesTool = wrap(
  "listFiles",
  "List uploaded files (receipts/invoices) with optional filters: search (file name / extracted partner), partnerId, " +
    "dateFrom/dateTo (document date), minAmount/maxAmount (document total in cents), hasConnections, and the review " +
    "queues. Amounts are integer cents. Purged files and documents that are not invoices are never listed. " +
    "Returns files and nextCursor.",
  mcpSchema("list_files", { overrides: { limit: chatLimit } })
);

export const getFileTool = wrap(
  "getFile",
  "Get full details of a file by ID: extracted data (extractedPartner, extractedAmount in cents, extractedDate, " +
    "extractedVatId, extractedIban, invoiceDirection), connection status (partnerId, transactionIds), suggestions " +
    "and metadata. Use this to see all information about a file before searching for matches.",
  mcpSchema("get_file")
);

export const listPartnersTool = wrap(
  "listPartners",
  "List or search partners (vendors/suppliers). search matches name, aliases and VAT ID. Returns partners and nextCursor.",
  mcpSchema("list_partners", { overrides: { limit: chatLimit } })
);

export const getPartnerTool = wrap(
  "getPartner",
  "Get full details of a partner by ID. A partner merged into another reads back with isActive false, mergedInto " +
    "and survivor ({ id, name }): use the survivor's id from then on.",
  mcpSchema("get_partner")
);

export const listCategoriesTool = wrap(
  "listCategories",
  "List the user's no-receipt categories (e.g. 'Private/Personal', 'Bank Fees', 'Internal Transfers'): id, templateId, " +
    "name. Call this whenever the user mentions a category by name so you can resolve it to an id. Use templateId " +
    "'private-personal' when the user says 'private'. Use the id (or templateId) with listTransactions / " +
    "bulkUpdateTransactions.",
  mcpSchema("list_no_receipt_categories")
);

export const updateTransactionTool = wrap(
  "updateTransaction",
  "Update a transaction's description or completion status. The change is recorded in the transaction's history " +
    "(the reply's historyId), which rollbackTransaction restores from. REQUIRES USER CONFIRMATION.",
  mcpSchema("update_transaction", { pick: ["transactionId", "description", "isComplete"] })
);

export const createSourceTool = wrap(
  "createSource",
  "Create a new bank account/source. REQUIRES USER CONFIRMATION.",
  mcpSchema("create_source", { pick: ["name", "iban", "currency"] })
);

/** Every wrapper, for the guard test. The agent lists them in READ_TOOLS / WRITE_TOOLS. */
export const MCP_TOOLS = [
  listSourcesTool,
  getSourceTool,
  listTransactionsTool,
  getTransactionTool,
  listFilesTool,
  getFileTool,
  listPartnersTool,
  getPartnerTool,
  listCategoriesTool,
  updateTransactionTool,
  createSourceTool,
];
