# FiBuKI Integrations

External integrations for FiBuKI Tax Studio.

## Available Integrations

### OpenClaw Plugin (`/openclaw-plugin`)

Allows AI assistants using OpenClaw to manage your FiBuKI account - transactions, receipts, bank accounts, and tax categorization.

**Setup:**
1. Generate an API key in **Settings > Integrations > AI Agents**
2. Install the plugin:
   ```bash
   openclaw plugins install @fibukiapp/openclaw-plugin
   ```
3. Configure:
   ```json5
   {
     plugins: {
       entries: {
         "fibuki": {
           enabled: true,
           config: {
             apiKey: "fk_your_api_key_here"
           }
         }
       }
     }
   }
   ```

See [openclaw-plugin/README.md](./openclaw-plugin/README.md) for full documentation.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     AI CLIENTS                               │
│  OpenClaw  │  Claude Desktop  │  Custom Agents              │
└─────────────────────────────────────────────────────────────┘
                              │
                    HTTPS + API Key
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              FiBuKI MCP API (Cloud Functions)               │
│  POST /mcpApi { tool: "list_transactions", arguments: {} }  │
│  Authorization: Bearer fk_xxxxx                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        FIRESTORE                            │
│  sources │ transactions │ files │ noReceiptCategories       │
└─────────────────────────────────────────────────────────────┘
```

## API Reference

The MCP API is available at:
```
https://europe-west1-taxstudio-f12fb.cloudfunctions.net/mcpApi
```

### Authentication
All requests require an API key in the Authorization header:
```
Authorization: Bearer fk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### Request Format
```json
{
  "tool": "list_transactions",
  "arguments": {
    "isComplete": false,
    "limit": 10
  }
}
```

### Response Format
```json
{
  "success": true,
  "result": [...]
}
```

### Available Tools
- `list_sources`, `get_source`
- `list_transactions`, `get_transaction`, `update_transaction`
- `list_files`, `get_file`, `connect_file_to_transaction`, `disconnect_file_from_transaction`
- `list_transactions_needing_files`, `auto_connect_file_suggestions`
- `list_no_receipt_categories`, `assign_no_receipt_category`, `remove_no_receipt_category`
