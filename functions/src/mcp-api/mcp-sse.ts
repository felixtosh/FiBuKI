/**
 * MCP Server over HTTP/SSE
 *
 * Implements the Model Context Protocol for remote connections.
 * Used by Claude Desktop, Anthropic API, and other MCP clients.
 *
 * Endpoint: POST /mcp (with SSE response)
 * Auth: Bearer token (API key)
 */

import { onRequest } from "firebase-functions/v2/https";
import { validateApiKey } from "../api-keys";
import { handleToolInternal } from "./handlers";
import { TOOL_DEFINITIONS } from "../tools/definitions";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// MCP Protocol version
const MCP_VERSION = "2024-11-05";

// Tool definitions in MCP format (derived from central definitions)
const MCP_TOOLS = TOOL_DEFINITIONS;

/**
 * MCP SSE Endpoint
 *
 * Handles MCP JSON-RPC requests and returns SSE responses
 */
export const mcpSse = onRequest(
  {
    region: "europe-west1",
    memory: "512MiB",
    timeoutSeconds: 300,
  },
  async (req, res) => {
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
    const validated = await validateApiKey(apiKey);
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
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(200).json({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message },
      });
    }
  }
);

async function handleMethod(userId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
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
      return handleToolCall(userId, params.name as string, params.arguments as Record<string, unknown>);

    case "ping":
      return {};

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

async function handleToolCall(
  userId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const result = await handleToolInternal(userId, toolName, args);

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}
