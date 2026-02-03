/**
 * MCP HTTP API
 *
 * Exposes MCP tools via HTTP with API key authentication.
 * This allows external tools (OpenClaw, Claude Desktop, ChatGPT) to access FiBuKI.
 */

import { onRequest } from "firebase-functions/v2/https";
import { validateApiKey } from "../api-keys";
import { handleToolInternal } from "./handlers";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json",
};

interface McpRequest {
  tool: string;
  arguments: Record<string, unknown>;
}

/**
 * Main MCP API endpoint (REST)
 *
 * POST /mcpApi
 * Headers: Authorization: Bearer fk_xxxxx
 * Body: { "tool": "list_transactions", "arguments": { "limit": 10 } }
 */
export const mcpApi = onRequest(
  {
    region: "europe-west1",
    memory: "512MiB",
    timeoutSeconds: 120,
  },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.set(CORS_HEADERS);
      res.status(204).send("");
      return;
    }

    res.set(CORS_HEADERS);

    if (req.method !== "POST") {
      res.status(405).json({ success: false, error: "Method not allowed" });
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ success: false, error: "Missing or invalid Authorization header" });
      return;
    }

    const apiKey = authHeader.substring(7);
    const validated = await validateApiKey(apiKey);
    if (!validated) {
      res.status(401).json({ success: false, error: "Invalid or expired API key" });
      return;
    }

    const body = req.body as McpRequest;
    if (!body.tool) {
      res.status(400).json({ success: false, error: "Missing 'tool' in request body" });
      return;
    }

    try {
      const result = await handleToolInternal(validated.userId, body.tool, body.arguments || {});
      res.status(200).json({ success: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[MCP API] Error in ${body.tool}:`, message);
      res.status(400).json({ success: false, error: message });
    }
  }
);

/**
 * List available tools
 */
export const mcpToolsList = onRequest({ region: "europe-west1" }, async (req, res) => {
  res.set(CORS_HEADERS);

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  res.status(200).json({
    tools: TOOL_DEFINITIONS,
  });
});

const TOOL_DEFINITIONS = [
  { name: "list_sources", description: "List all bank accounts/sources" },
  { name: "get_source", description: "Get a single bank account by ID" },
  { name: "list_transactions", description: "List transactions with filters" },
  { name: "get_transaction", description: "Get a transaction by ID" },
  { name: "update_transaction", description: "Update transaction description/status" },
  { name: "list_files", description: "List uploaded files with match suggestions" },
  { name: "get_file", description: "Get a file by ID" },
  { name: "connect_file_to_transaction", description: "Connect file to transaction" },
  { name: "disconnect_file_from_transaction", description: "Disconnect file from transaction" },
  { name: "list_transactions_needing_files", description: "Find transactions without receipts" },
  { name: "auto_connect_file_suggestions", description: "Auto-connect high-confidence matches" },
  { name: "list_no_receipt_categories", description: "List no-receipt categories" },
  { name: "assign_no_receipt_category", description: "Assign category to transaction" },
  { name: "remove_no_receipt_category", description: "Remove category from transaction" },
];

// Re-export MCP SSE endpoint
export { mcpSse } from "./mcp-sse";
