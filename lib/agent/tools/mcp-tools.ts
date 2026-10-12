/**
 * Chat tools with an MCP twin (#616).
 *
 * Each is a thin wrapper over the backend's `runTool` callable, which runs the
 * named MCP tool through the same handler MCP and the REST API use, as the
 * session's User. So there is one implementation of each: filtering,
 * validation and every computed figure live in the shared tool, and the chat
 * sees exactly what an external integration sees. The MCP output shape is the
 * contract; a wrapper passes it through, reformatted for reading only
 * (forTheModel: Timestamps as ISO strings, a File's OCR text and a
 * Transaction's import and automation bookkeeping left out of list rows). It
 * never filters rows or computes a figure.
 *
 * Where the shared tool differs for the chat agent (#665: the provenance a
 * Partner assignment or a File Connection records, the agent's connect
 * checks), it is because runTool calls it as the agent, never because of
 * anything a wrapper sends.
 *
 * The parameters come from the MCP definition (functions/src/tools/definitions.ts),
 * so a parameter added there reaches the chat without a second edit. Only the
 * description, the default page size and the agent's own connect parameters
 * are the chat's.
 *
 * Nothing in this file touches the database; the guard in
 * functions/src/selfhost/chat-mcp-tools.test.ts fails if it does.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { callFirebaseFunction } from "@/lib/api/firebase-callable";
import { TOOL_DEFINITIONS } from "@/functions/src/tools/definitions";

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
  connectFileToTransaction: "connect_file_to_transaction",
  assignPartnerToTransaction: "assign_partner_to_transaction",
  assignPartnerToFile: "assign_partner_to_file",
  updatePartner: "update_partner",
  createPartner: "create_partner",
  markFileAsCopy: "mark_file_as_copy",
  unmarkFileAsCopy: "unmark_file_as_copy",
  makeFileTheOriginal: "make_file_the_original",
  linkCorrection: "link_correction",
  unlinkCorrection: "unlink_correction",
  getCorrection: "get_correction",
  linkReceipt: "link_receipt",
  unlinkReceipt: "unlink_receipt",
  getReceiptLink: "get_receipt_link",
  splitFile: "split_file",
  dismissSplitSuggestion: "dismiss_split_suggestion",
} as const;

type ChatTwin = keyof typeof MCP_TWINS;

interface ToolConfig {
  configurable?: { authHeader?: string; workerType?: string };
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

// ============================================================================
// Display: what the model reads (reformatting only, never filtering or computing)
// ============================================================================

/** A Firestore Timestamp after a JSON round trip: exactly these two keys. */
function isWireTimestamp(value: unknown): value is { _seconds: number; _nanoseconds: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const v = value as Record<string, unknown>;
  return (
    keys.length === 2 &&
    typeof v._seconds === "number" &&
    typeof v._nanoseconds === "number"
  );
}

/** Every Timestamp as an ISO string: the model cannot be trusted to turn epoch seconds into a calendar day. */
function readableTimestamps(value: unknown): unknown {
  if (isWireTimestamp(value)) {
    return new Date(value._seconds * 1000 + Math.floor(value._nanoseconds / 1e6)).toISOString();
  }
  if (Array.isArray(value)) return value.map(readableTimestamps);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, readableTimestamps(v)]));
  }
  return value;
}

/**
 * Fields a list row leaves out of the model's context; the single-record get
 * still returns every one of them for the record that needs reading.
 *
 * - A File's OCR text is often kilobytes; a page of twenty would crowd out
 *   the conversation.
 * - A Transaction carries the import's raw CSV row (`_original`, `dedupeHash`,
 *   `csvRowIndex`), the automation log, the matchers' stored suggestions
 *   (Partner, category, search queries, card reconciliation) and the dated
 *   rejection log. None of it answers a question about the row; what does
 *   (ids, date, amount, name, partner, description, completion, file ids and
 *   rejected file ids, category, documentation state, the UVA answers) stays.
 */
const LIST_ROW_OMIT: Record<string, { rows: string; fields: string[] }> = {
  list_files: { rows: "files", fields: ["extractedText"] },
  list_transactions: {
    rows: "transactions",
    fields: [
      "_original",
      "dedupeHash",
      "csvRowIndex",
      "automationHistory",
      "partnerSuggestions",
      "categorySuggestions",
      "searchSuggestions",
      "aiSearchQueries",
      "aiSearchQueriesForPartnerId",
      "reconciliationSuggestions",
      "rejectedFiles",
    ],
  },
};

/**
 * The MCP output as the model reads it: Timestamps as ISO strings and, on a
 * list, the bulky fields above left out of each row. Rows, values and every
 * other field pass through unchanged.
 */
export function forTheModel(mcpName: string, result: unknown): unknown {
  let out = readableTimestamps(result);
  const omit = LIST_ROW_OMIT[mcpName];
  if (omit && out && typeof out === "object" && !Array.isArray(out)) {
    const page = out as Record<string, unknown>;
    const rows = page[omit.rows];
    if (Array.isArray(rows)) {
      out = {
        ...page,
        [omit.rows]: rows.map((row) =>
          row && typeof row === "object"
            ? Object.fromEntries(Object.entries(row).filter(([k]) => !omit.fields.includes(k)))
            : row
        ),
      };
    }
  }
  return out;
}

/**
 * Run one MCP tool as the session's User. A failure is returned, not thrown,
 * as every chat tool does.
 *
 * runTool runs it as the chat agent (#665), which the few writes that record
 * who made them read. When one of the agent's workers runs it, the worker
 * type goes along beside the arguments, never among them: the agent's connect
 * checks differ per worker. It is the worker runtime's, not the model's.
 */
export async function runMcpTool(
  name: string,
  args: Record<string, unknown>,
  config?: ToolConfig
): Promise<unknown> {
  const authHeader = config?.configurable?.authHeader;
  if (!authHeader) return { error: "Auth header not provided" };
  const defined = Object.fromEntries(Object.entries(args ?? {}).filter(([, v]) => v !== undefined));
  const workerType = config?.configurable?.workerType;
  try {
    const result = forTheModel(
      name,
      await callFirebaseFunction<
        { tool: string; arguments: Record<string, unknown>; workerType?: string },
        unknown
      >("runTool", { tool: name, arguments: defined, ...(workerType ? { workerType } : {}) }, authHeader)
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

// The writes that record who made them (#665): runTool calls them as the chat
// agent, so the shared tool records the agent's provenance (`ai`, Connection
// Origin `agent`) where MCP records its own.

export const assignPartnerToTransactionTool = wrap(
  "assignPartnerToTransaction",
  "Assign a partner (vendor/supplier) to a transaction. Use after finding/creating the partner. A partner the " +
    "user removed from this transaction before is refused: do not retry it. A merged partner is refused naming " +
    "its survivor: use the survivor's id.",
  mcpSchema("assign_partner_to_transaction")
);

export const assignPartnerToFileTool = wrap(
  "assignPartnerToFile",
  "Assign a partner (vendor/supplier) to a file/invoice. Use after finding/creating the partner. This directly " +
    "assigns the partner to the file without needing a transaction. A merged partner is refused naming its " +
    "survivor: use the survivor's id.",
  mcpSchema("assign_partner_to_file")
);

export const updatePartnerTool = wrap(
  "updatePartner",
  "Update an existing partner's details. VAT IDs are automatically validated via EU VIES: the reply is the " +
    "partner record, plus vatIdCheck ({ vatId, valid, name, error }) when you passed a VAT ID, where valid is " +
    "null when VIES could not be asked. The VAT ID is stored either way. Use this to correct partner " +
    "information like name, VAT ID, website, or country. aliases replaces the stored list.",
  mcpSchema("update_partner", { pick: ["partnerId", "name", "aliases", "vatId", "website", "country"] })
);

/**
 * The chat's connect: MCP's tool, plus the agent's checks, which the shared
 * handler applies because runTool calls it as the agent. The extra parameters
 * are the agent's only; MCP's surface has none of them.
 */
export const connectFileToTransactionTool = wrap(
  "connectFileToTransaction",
  `Connect an existing local file to a transaction. Use when searchLocalFiles finds a good match.

IMPORTANT: This tool validates that the file matches the transaction before connecting:
- Amount must be within 50-200% of transaction amount
- Partner mismatch is treated as a warning unless amount/date evidence is strong

If validation fails, the connection is blocked (error VALIDATION_FAILED, with extractedAmount and transactionAmount in integer cents). Review the warnings before proceeding.
Only use skipValidation=true if you're certain the file belongs to this transaction despite the mismatch.
Note: In receipt_search worker mode, skipValidation is ignored for safety.

Separately, a pair the file has previously rejected is refused outright with error PAIR_REJECTED. skipValidation does NOT lift that. Treat it as final: choose a different file, or leave the transaction unmatched.`,
  mcpSchema("connect_file_to_transaction", {
    overrides: {
      confidence: z.number().optional().describe("Match confidence score (0-100)"),
      skipValidation: z
        .boolean()
        .optional()
        .describe("Set to true to skip amount/partner validation (use with caution)"),
      overrideDismissal: z
        .boolean()
        .optional()
        .describe(
          "Connect even though this pair was previously rejected. Only when a human has explicitly asked for this exact pair — never to retry your own PAIR_REJECTED error."
        ),
      searchQuery: z.string().optional().describe("The search query that found this file"),
      sourceType: z
        .string()
        .optional()
        .describe("How file was found: local, gmail_attachment, gmail_email, browser"),
    },
  })
);

export const createPartnerTool = wrap(
  "createPartner",
  "Create a new partner (vendor/supplier). Only after listPartners found no existing partner for this company " +
    "(search its name variants, VAT ID and IBAN) and lookupCompanyInfo or validateVatId confirmed who it is: pass " +
    "the verified name, VAT ID, website and country.",
  mcpSchema("create_partner")
);

// Copy (#162, ADR-0010), Invoice Corrections (#564) and Receipt Links (#571, ADR-0012).

export const markFileAsCopyTool = wrap(
  "markFileAsCopy",
  "Record a file as a Copy of another file: a second File of the same invoice that arrived by another route (mailbox and a document system, or a mailed copy of an invoice the user issued). A Copy holds no transaction connection and is never proposed as a match; if it was connected, the connection moves to the original where the original lacks it. Also accepts a Copy suggestion. A receipt for the same charge as an invoice is NOT a Copy, nor is a payment reminder. Reversible with unmarkFileAsCopy.",
  mcpSchema("mark_file_as_copy")
);

export const unmarkFileAsCopyTool = wrap(
  "unmarkFileAsCopy",
  "Not a Copy: undo a Copy, or decline a Copy suggestion on a file. The pair is never suggested again. Undoing reconnects nothing; the file goes back to matching.",
  mcpSchema("unmark_file_as_copy")
);

export const makeFileTheOriginalTool = wrap(
  "makeFileTheOriginal",
  "Swap a Copy and its original: the given Copy becomes the original and takes over the transaction connections; the former original becomes its Copy.",
  mcpSchema("make_file_the_original")
);

export const linkCorrectionTool = wrap(
  "linkCorrection",
  "Link an Invoice Correction (a supplier's credit note, a Gutschrift reducing an earlier invoice, a Rechnungskorrektur) to the File it corrects. The UVA then books the refund against the original's Vorsteuer (KZ 067) or revenue, at the original's rates; an unlinked correction blocks the period's filing. Also accepts a link suggestion. Reversible with unlinkCorrection.",
  mcpSchema("link_correction")
);

export const unlinkCorrectionTool = wrap(
  "unlinkCorrection",
  "Remove an Invoice Correction's link, or decline one of its link suggestions (pass originalFileId). That File is never linked to it automatically again.",
  mcpSchema("unlink_correction")
);

export const getCorrectionTool = wrap(
  "getCorrection",
  "Inspect Invoice Corrections: for a File, what it corrects, who paid the original, its link suggestions and the corrections linked to it; for a transaction, the transactions related to it through a correction (a refund and the purchase it refunds).",
  mcpSchema("get_correction")
);

export const linkReceiptTool = wrap(
  "linkReceipt",
  "Link a Receipt (a payment confirmation: GitHub's or Stripe's receipt, a card terminal slip) to the invoice it pays. Both stay on the transaction and count once: the invoice's figures and Vorsteuer, the Receipt's surplus (a tip) as Trinkgeld without VAT. If one File is on a transaction and the other on none, the other follows. Also accepts a pairing suggestion. Reversible with unlinkReceipt.",
  mcpSchema("link_receipt")
);

export const unlinkReceiptTool = wrap(
  "unlinkReceipt",
  "Remove a Receipt Link, or decline a pairing suggestion (pass otherFileId). The pair is never linked or suggested automatically again. No transaction connection changes.",
  mcpSchema("unlink_receipt")
);

export const getReceiptLinkTool = wrap(
  "getReceiptLink",
  "Inspect a File's Receipt Link: the invoice it is the Receipt of, or the Receipts linked to it, and its pairing suggestions.",
  mcpSchema("get_receipt_link")
);

// Split (#550). The ranges keep their shape for the model; the MCP schema's
// nested object would read as a bare record.

export const splitFileTool = wrap(
  "splitFile",
  "Split a PDF that holds several separately issued invoices or Receipts (an Amazon Marketplace order with one Rechnung or Quittung per seller) into one file per invoice or Receipt. The ranges cover every page exactly once, in order. Each part is extracted from scratch and connected to the original's transactions; the original is deleted, and can be restored only after its parts are deleted. Use the file's splitSuggestion for the ranges when it has one.",
  mcpSchema("split_file", {
    overrides: {
      ranges: z
        .array(z.object({ from: z.number().int(), to: z.number().int() }))
        .min(2)
        .describe("The parts in page order: first and last page of each, 1-based and inclusive"),
    },
  })
);

export const dismissSplitSuggestionTool = wrap(
  "dismissSplitSuggestion",
  "Say a file is one document, not several: removes its splitSuggestion, and re-extraction never stores a new one. Use it when the suggestion is wrong, such as one invoice running over several pages. splitFile still splits the file by explicit ranges.",
  mcpSchema("dismiss_split_suggestion")
);

/** Every wrapper, for the guard test. The agent lists them in READ_TOOLS / WRITE_TOOLS / SEARCH_TOOLS. */
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
  assignPartnerToTransactionTool,
  assignPartnerToFileTool,
  updatePartnerTool,
  connectFileToTransactionTool,
  createPartnerTool,
  markFileAsCopyTool,
  unmarkFileAsCopyTool,
  makeFileTheOriginalTool,
  linkCorrectionTool,
  unlinkCorrectionTool,
  getCorrectionTool,
  linkReceiptTool,
  unlinkReceiptTool,
  getReceiptLinkTool,
  splitFileTool,
  dismissSplitSuggestionTool,
];
