/**
 * FiBuKI MCP server (Streamable HTTP, stateless, JSON responses).
 *
 * Built on the official @modelcontextprotocol/sdk so protocol negotiation,
 * notifications and error shapes follow the current spec (2025-11-25) while
 * older clients that still speak 2024-11-05 keep working.
 *
 * The tools themselves are unchanged: TOOL_DEFINITIONS lists them and
 * handleToolInternal runs them, exactly as the REST endpoint (mcpApi) does.
 * This file only adds what MCP clients need around them: annotations,
 * structuredContent, isError, and server instructions.
 *
 * Stateless: every HTTP request gets a fresh Server + transport, so nothing is
 * kept between requests and any fibuki-api replica can answer any request.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOL_DEFINITIONS, TOOL_NAMES } from "../tools/definitions";
import { handleToolInternal } from "./handlers";
import { annotationsFor } from "./tool-annotations";

export const MCP_SERVER_NAME = "FiBuKI";
export const MCP_SERVER_VERSION = "0.2.0";

/**
 * Sent once at initialize. Clients weigh the first 512 characters most, so the
 * rules that protect the user's books come first.
 */
export const MCP_INSTRUCTIONS = [
  "FiBuKI is pre-accounting for Austrian one-person businesses: bank Transactions, receipt and invoice Files, and the Matches between them, prepared for the user's Tax Advisor.",
  "Amounts are integer cents; negative is an expense. Dates are ISO 8601.",
  "Individual Transactions can never be deleted; only a whole Bank Account (delete_source).",
  "Match scores come from FiBuKI; never score yourself. Suggestions at confidence 85+ are safe to connect after the user confirms.",
  "Start with get_automation_status to see the plan and which tools it allows.",
].join(" ");

/** Tool list in MCP shape. requiredFeature is FiBuKI-specific, so it moves to _meta. */
export function listMcpTools(): Tool[] {
  return TOOL_DEFINITIONS.map((def) => {
    const annotations = annotationsFor(def.name);
    const tool: Tool = {
      name: def.name,
      title: annotations.title,
      description: def.description,
      // The definitions are plain JSON Schema; the SDK types property values as object.
      inputSchema: def.inputSchema as Tool["inputSchema"],
      annotations,
    };
    if (def.requiredFeature) {
      tool._meta = { "fibuki/requiredFeature": def.requiredFeature };
    }
    return tool;
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Run one tool. A failure inside the tool (bad argument, plan gate, not found)
 * is returned as isError so the model can read it and recover; only an unknown
 * tool name is a protocol error.
 */
export async function callMcpTool(
  userId: string,
  name: string,
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  if (!TOOL_NAMES.includes(name)) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
  }

  try {
    const result = await handleToolInternal(userId, name, args ?? {});
    return {
      content: [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }],
      structuredContent: isPlainObject(result) ? result : { result: result ?? null },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

export function buildMcpServer(userId: string): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listMcpTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callMcpTool(userId, request.params.name, request.params.arguments)
  );

  return server;
}

/**
 * Answer one MCP HTTP request for an already-authenticated user.
 * `parsedBody` is the JSON body the host's body parser already read.
 */
export async function handleMcpRequest(
  userId: string,
  request: Request,
  parsedBody?: unknown
): Promise<Response> {
  const server = buildMcpServer(userId);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request, { parsedBody });
  } finally {
    // With enableJsonResponse the body is fully built before handleRequest
    // resolves, so closing here cannot cut a response short.
    await server.close();
  }
}
