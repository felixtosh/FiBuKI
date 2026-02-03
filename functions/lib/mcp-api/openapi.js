"use strict";
/**
 * OpenAPI Spec for ChatGPT Actions
 *
 * Serves the OpenAPI 3.0 specification for ChatGPT custom actions.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiPluginManifest = exports.openApiSpec = void 0;
const https_1 = require("firebase-functions/v2/https");
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
};
const OPENAPI_SPEC = {
    openapi: "3.0.0",
    info: {
        title: "FiBuKI Tax Studio API",
        description: "Manage bank transactions, receipts, and tax categorization for German small businesses.",
        version: "1.0.0",
    },
    servers: [
        {
            url: "https://europe-west1-taxstudio-f12fb.cloudfunctions.net",
            description: "Production",
        },
    ],
    paths: {
        "/mcpApi": {
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
                                        result: {
                                            description: "Tool-specific result data",
                                        },
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
                description: "FiBuKI API key (starts with fk_). Generate at fibuki.com Settings > Integrations > AI Agents",
            },
        },
        schemas: {
            Transaction: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    date: { type: "string", format: "date" },
                    amount: { type: "integer", description: "Amount in cents" },
                    amountFormatted: { type: "string", example: "25.00 EUR" },
                    name: { type: "string" },
                    description: { type: "string" },
                    partner: { type: "string" },
                    isComplete: { type: "boolean" },
                    fileIds: { type: "array", items: { type: "string" } },
                    noReceiptCategoryId: { type: "string" },
                },
            },
            File: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    fileName: { type: "string" },
                    extractedAmount: { type: "integer", description: "Amount in cents" },
                    extractedPartner: { type: "string" },
                    transactionIds: { type: "array", items: { type: "string" } },
                    transactionSuggestions: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                transactionId: { type: "string" },
                                confidence: { type: "number" },
                            },
                        },
                    },
                },
            },
            Source: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    iban: { type: "string" },
                    accountKind: { type: "string", enum: ["bank_account", "credit_card"] },
                    currency: { type: "string", example: "EUR" },
                },
            },
            Category: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    description: { type: "string" },
                    templateId: { type: "string" },
                },
            },
        },
    },
    "x-tool-descriptions": {
        list_sources: "List all bank accounts/sources for the user",
        get_source: "Get details of a specific bank account. Args: sourceId (string)",
        list_transactions: "List transactions with filters. Args: sourceId?, dateFrom?, dateTo?, search?, isComplete? (boolean), limit? (number, max 100)",
        get_transaction: "Get full transaction details. Args: transactionId (string)",
        update_transaction: "Update transaction description or status. Args: transactionId (string), description? (string), isComplete? (boolean)",
        list_files: "List uploaded files/receipts. Args: hasConnections? (boolean), hasSuggestions? (boolean), limit? (number)",
        get_file: "Get file details including suggestions. Args: fileId (string)",
        connect_file_to_transaction: "Connect a file to a transaction (marks transaction complete). Args: fileId (string), transactionId (string)",
        disconnect_file_from_transaction: "Disconnect a file from a transaction. Args: fileId (string), transactionId (string)",
        list_transactions_needing_files: "Find transactions without receipts. Args: minAmount? (number, in cents), limit? (number)",
        auto_connect_file_suggestions: "Auto-connect files to transactions above confidence threshold. Args: fileId? (string), minConfidence? (number, 0-100, default 89)",
        list_no_receipt_categories: "List categories for transactions that don't need receipts (bank fees, payroll, etc.)",
        assign_no_receipt_category: "Assign a no-receipt category to a transaction. Args: transactionId (string), categoryId (string)",
        remove_no_receipt_category: "Remove a no-receipt category from a transaction. Args: transactionId (string)",
    },
};
/**
 * Serve OpenAPI spec for ChatGPT actions
 */
exports.openApiSpec = (0, https_1.onRequest)({ region: "europe-west1" }, async (req, res) => {
    res.set(CORS_HEADERS);
    if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
    }
    res.status(200).json(OPENAPI_SPEC);
});
/**
 * ChatGPT plugin manifest (ai-plugin.json)
 */
exports.aiPluginManifest = (0, https_1.onRequest)({ region: "europe-west1" }, async (req, res) => {
    res.set(CORS_HEADERS);
    if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
    }
    res.status(200).json({
        schema_version: "v1",
        name_for_human: "FiBuKI Tax Studio",
        name_for_model: "fibuki",
        description_for_human: "Manage your bank transactions, receipts, and tax categorization.",
        description_for_model: "FiBuKI is a German tax accounting tool. Use this to help users manage their bank transactions, match receipts to transactions, and categorize expenses. Key concepts: Sources are bank accounts. Transactions come from sources. Files are uploaded receipts/invoices. A transaction is complete when it has a file or a no-receipt category. Amounts are in cents (divide by 100 for display).",
        auth: {
            type: "user_http",
            authorization_type: "bearer",
        },
        api: {
            type: "openapi",
            url: "https://europe-west1-taxstudio-f12fb.cloudfunctions.net/openApiSpec",
        },
        logo_url: "https://fibuki.com/icon.png",
        contact_email: "support@fibuki.com",
        legal_info_url: "https://fibuki.com/terms",
    });
});
//# sourceMappingURL=openapi.js.map