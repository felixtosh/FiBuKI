/**
 * OpenAPI Spec for ChatGPT Actions
 *
 * https://fibuki.com/api/openapi.json
 *
 * Tool list is auto-generated from functions/src/tools/definitions.ts
 * via: npm run generate:tool-definitions
 */

import { NextResponse } from "next/server";
import { TOOL_DEFINITIONS } from "@/lib/data/generated-tool-definitions";

export async function GET() {
  const toolNames = TOOL_DEFINITIONS.map((t) => t.name);

  const toolDescriptions: Record<string, string> = {};
  for (const t of TOOL_DEFINITIONS) {
    const required = t.inputSchema.required;
    const props = t.inputSchema.properties;
    const argParts: string[] = [];
    for (const [key, schema] of Object.entries(props)) {
      const s = schema as { type?: string; description?: string };
      const isRequired = required?.includes(key);
      argParts.push(`${key}${isRequired ? "" : "?"} (${s.type || "any"}${s.description ? ` — ${s.description}` : ""})`);
    }
    const argStr = argParts.length > 0 ? `. Args: ${argParts.join(", ")}` : "";
    toolDescriptions[t.name] = `${t.description}${argStr}`;
  }

  return NextResponse.json({
    openapi: "3.0.0",
    info: {
      title: "FiBuKI Tax Studio API",
      description:
        "Manage bank transactions, receipts, and tax categorization for German small businesses.",
      version: "1.0.0",
    },
    servers: [
      {
        url: "https://fibuki.com",
        description: "Production",
      },
    ],
    paths: {
      "/api/mcp": {
        post: {
          operationId: "executeTool",
          summary: "Execute a FiBuKI tool",
          description: "Execute any FiBuKI tool by name with arguments",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["tool"],
                  properties: {
                    tool: {
                      type: "string",
                      enum: toolNames,
                      description: "The tool to execute",
                    },
                    arguments: {
                      type: "object",
                      description: "Tool-specific arguments",
                      additionalProperties: true,
                    },
                  },
                },
                examples: {
                  listTransactions: {
                    summary: "List incomplete transactions",
                    value: {
                      tool: "list_transactions",
                      arguments: { isComplete: false, limit: 10 },
                    },
                  },
                  connectFile: {
                    summary: "Connect a file to a transaction",
                    value: {
                      tool: "connect_file_to_transaction",
                      arguments: { fileId: "abc123", transactionId: "xyz789" },
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      result: { description: "Tool-specific result data" },
                    },
                  },
                },
              },
            },
            "400": {
              description: "Bad request",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean", example: false },
                      error: { type: "string" },
                    },
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized - invalid or missing API key",
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "FiBuKI API key (starts with fk_). Generate at fibuki.com Settings > Integrations > AI Agents, or run: npx @fibukiapp/cli auth",
        },
      },
    },
    "x-tool-descriptions": toolDescriptions,
  });
}
