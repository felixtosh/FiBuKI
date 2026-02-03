/**
 * OpenAPI Spec for ChatGPT Actions
 *
 * https://fibuki.com/api/openapi.json
 */

import { NextResponse } from "next/server";

export async function GET() {
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
                      enum: [
                        "list_sources",
                        "get_source",
                        "list_transactions",
                        "get_transaction",
                        "update_transaction",
                        "list_files",
                        "get_file",
                        "connect_file_to_transaction",
                        "disconnect_file_from_transaction",
                        "list_transactions_needing_files",
                        "auto_connect_file_suggestions",
                        "list_no_receipt_categories",
                        "assign_no_receipt_category",
                        "remove_no_receipt_category",
                      ],
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
            "FiBuKI API key (starts with fk_). Generate at fibuki.com Settings > Integrations > AI Agents",
        },
      },
    },
    "x-tool-descriptions": {
      list_sources: "List all bank accounts/sources for the user",
      get_source: "Get details of a specific bank account. Args: sourceId (string)",
      list_transactions:
        "List transactions with filters. Args: sourceId?, dateFrom?, dateTo?, search?, isComplete? (boolean), limit? (number, max 100)",
      get_transaction: "Get full transaction details. Args: transactionId (string)",
      update_transaction:
        "Update transaction description or status. Args: transactionId (string), description? (string), isComplete? (boolean)",
      list_files:
        "List uploaded files/receipts. Args: hasConnections? (boolean), hasSuggestions? (boolean), limit? (number)",
      get_file: "Get file details including suggestions. Args: fileId (string)",
      connect_file_to_transaction:
        "Connect a file to a transaction (marks transaction complete). Args: fileId (string), transactionId (string)",
      disconnect_file_from_transaction:
        "Disconnect a file from a transaction. Args: fileId (string), transactionId (string)",
      list_transactions_needing_files:
        "Find transactions without receipts. Args: minAmount? (number, in cents), limit? (number)",
      auto_connect_file_suggestions:
        "Auto-connect files to transactions above confidence threshold. Args: fileId? (string), minConfidence? (number, 0-100, default 89)",
      list_no_receipt_categories:
        "List categories for transactions that don't need receipts (bank fees, payroll, etc.)",
      assign_no_receipt_category:
        "Assign a no-receipt category to a transaction. Args: transactionId (string), categoryId (string)",
      remove_no_receipt_category:
        "Remove a no-receipt category from a transaction. Args: transactionId (string)",
    },
  });
}
