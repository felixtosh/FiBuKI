/**
 * llm.txt — Machine-readable service description
 *
 * https://fibuki.com/llm.txt
 *
 * Follows the llm.txt convention for AI-discoverable APIs.
 * Tool list is auto-generated from functions/src/tools/definitions.ts
 * via: npm run generate:tool-definitions
 */

import { TOOL_DEFINITIONS } from "@/lib/data/generated-tool-definitions";

export async function GET() {
  const toolLines = TOOL_DEFINITIONS.map((t) => {
    const required = t.inputSchema.required ?? [];
    const props = Object.entries(t.inputSchema.properties);
    const argParts = props.map(([key, schema]) => {
      const s = schema as { type?: string; description?: string };
      return `${key}${required.includes(key) ? "" : "?"}: ${s.type || "any"}`;
    });
    const sig = argParts.length > 0 ? `(${argParts.join(", ")})` : "()";
    const featureTag = t.requiredFeature ? ` [requires: ${t.requiredFeature}]` : "";
    return `  - ${t.name}${sig}: ${t.description}${featureTag}`;
  });

  const body = `# FiBuKI — AI-powered tax bookkeeping for Austrian/German small businesses
> https://fibuki.com

## What FiBuKI does
FiBuKI manages bank transactions, receipts/invoices, and tax categorization.
Users import bank CSVs, upload or auto-import receipts (email, browser extension),
and FiBuKI matches receipts to transactions using AI scoring.

## Authentication
All API requests require a Bearer token (API key starting with \`fk_\`).
- Generate manually: fibuki.com → Settings → Integrations → AI Agents
- Generate via CLI: npx @fibukiapp/cli auth

Header: \`Authorization: Bearer fk_...\`

## Endpoints

### REST API (simple tool execution)
POST https://fibuki.com/api/mcp
Content-Type: application/json
Body: { "tool": "<tool_name>", "arguments": { ... } }

### MCP SSE (Model Context Protocol)
https://fibuki.com/api/mcp/sse
For Claude Desktop, Cursor, and other MCP-compatible clients.

### OpenAPI spec
GET https://fibuki.com/api/openapi.json

### CLI auth (device flow)
npx @fibukiapp/cli auth

## Tools
${toolLines.join("\n")}

## Key Concepts
- **Source**: A bank account or credit card. Transactions belong to a source.
- **Transaction**: A bank transaction (date, amount in cents, name, partner). Amounts are in cents; negative = expense.
- **File**: An uploaded receipt or invoice. AI extracts vendor, amount, date. Can be connected to transactions.
- **Partner**: A vendor/counterparty (e.g., "Amazon", "REWE"). Transactions and files are linked via partners.
- **Complete**: A transaction is "complete" when it has a file attached OR a no-receipt category assigned.
- **No-receipt category**: Categories for transactions that legally don't need receipts (bank fees, payroll, etc.).
- **Suggestion**: AI-generated match between a file and a transaction, scored 0–100 confidence.

## Quick Start

# List bank accounts
curl -X POST https://fibuki.com/api/mcp \\
  -H "Authorization: Bearer fk_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"tool": "list_sources"}'

# List incomplete transactions
curl -X POST https://fibuki.com/api/mcp \\
  -H "Authorization: Bearer fk_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"tool": "list_transactions", "arguments": {"isComplete": false, "limit": 10}}'

# Connect a file to a transaction
curl -X POST https://fibuki.com/api/mcp \\
  -H "Authorization: Bearer fk_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"tool": "connect_file_to_transaction", "arguments": {"fileId": "abc", "transactionId": "xyz"}}'
`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
