"use strict";
/**
 * MCP Server over HTTP/SSE
 *
 * Implements the Model Context Protocol for remote connections.
 * Used by Claude Desktop, Anthropic API, and other MCP clients.
 *
 * Endpoint: POST /mcp (with SSE response)
 * Auth: Bearer token (API key)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.mcpSse = void 0;
const https_1 = require("firebase-functions/v2/https");
const api_keys_1 = require("../api-keys");
const handlers_1 = require("./handlers");
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
// MCP Protocol version
const MCP_VERSION = "2024-11-05";
// Tool definitions in MCP format
const MCP_TOOLS = [
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
                limit: { type: "number", description: "Max results (default 50)" },
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
        name: "auto_connect_file_suggestions",
        description: "Auto-connect files to transactions above confidence threshold",
        inputSchema: {
            type: "object",
            properties: {
                fileId: { type: "string", description: "Specific file ID (optional)" },
                minConfidence: { type: "number", description: "Min confidence 0-100 (default 89)" },
            },
        },
    },
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
];
/**
 * MCP SSE Endpoint
 *
 * Handles MCP JSON-RPC requests and returns SSE responses
 */
exports.mcpSse = (0, https_1.onRequest)({
    region: "europe-west1",
    memory: "512MiB",
    timeoutSeconds: 300,
}, async (req, res) => {
    // Handle CORS
    if (req.method === "OPTIONS") {
        res.set(CORS_HEADERS);
        res.status(204).send("");
        return;
    }
    res.set(CORS_HEADERS);
    // Validate API key
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
        res.status(401).json({ error: "Missing Authorization header" });
        return;
    }
    const apiKey = authHeader.substring(7);
    const validated = await (0, api_keys_1.validateApiKey)(apiKey);
    if (!validated) {
        res.status(401).json({ error: "Invalid API key" });
        return;
    }
    const userId = validated.userId;
    // Handle GET for SSE connection info
    if (req.method === "GET") {
        res.status(200).json({
            name: "FiBuKI",
            version: "0.1.0",
            protocol: MCP_VERSION,
            capabilities: { tools: {} },
        });
        return;
    }
    // Handle POST for JSON-RPC
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    const { jsonrpc, id, method, params } = req.body;
    if (jsonrpc !== "2.0") {
        res.status(400).json({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid JSON-RPC" } });
        return;
    }
    try {
        const result = await handleMethod(userId, method, params || {});
        res.status(200).json({ jsonrpc: "2.0", id, result });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        res.status(200).json({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message },
        });
    }
});
async function handleMethod(userId, method, params) {
    switch (method) {
        case "initialize":
            return {
                protocolVersion: MCP_VERSION,
                serverInfo: { name: "FiBuKI", version: "0.1.0" },
                capabilities: { tools: {} },
            };
        case "tools/list":
            return { tools: MCP_TOOLS };
        case "tools/call":
            return handleToolCall(userId, params.name, params.arguments);
        case "ping":
            return {};
        default:
            throw new Error(`Unknown method: ${method}`);
    }
}
async function handleToolCall(userId, toolName, args) {
    const result = await (0, handlers_1.handleToolInternal)(userId, toolName, args);
    return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
}
//# sourceMappingURL=mcp-sse.js.map