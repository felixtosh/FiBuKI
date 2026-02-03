# FiBuKI OpenClaw Plugin

Manage your FiBuKI tax accounting data through AI assistants.

## What Claude Can Do

| Task | Tools Used |
|------|------------|
| **View bank accounts** | `list_sources`, `get_source` |
| **Browse transactions** | `list_transactions`, `get_transaction` |
| **Find incomplete work** | `list_transactions` (isComplete=false), `list_transactions_needing_files` |
| **Match receipts** | `list_files`, `connect_file_to_transaction`, `auto_connect_file_suggestions` |
| **Categorize transactions** | `list_no_receipt_categories`, `assign_no_receipt_category` |

## Installation

```bash
# From npm
openclaw plugins install @fibukiapp/openclaw-plugin

# Or link locally for development
cd integrations/openclaw-plugin
openclaw plugins install -l .
```

## Configuration

1. **Generate an API Key** in FiBuKI:
   - Go to **Settings > Integrations > AI Agents**
   - Click "Create API Key"
   - Copy the key (starts with `fk_`)

2. **Add to OpenClaw config:**

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

## Available Tools

### Bank Accounts
- `list_sources` - List all connected bank accounts
- `get_source` - Get details of a specific account

### Transactions
- `list_transactions` - Search/filter transactions (use `isComplete: false` for incomplete)
- `get_transaction` - Get full transaction details
- `update_transaction` - Update description, mark complete

### Files (Receipts/Invoices)
- `list_files` - List uploaded files with match suggestions
- `get_file` - Get file details including extracted data
- `connect_file_to_transaction` - Link file to transaction
- `disconnect_file_from_transaction` - Unlink file
- `list_transactions_needing_files` - Find transactions without receipts
- `auto_connect_file_suggestions` - Bulk-connect high-confidence matches

### No-Receipt Categories
- `list_no_receipt_categories` - List categories (bank fees, payroll, etc.)
- `assign_no_receipt_category` - Mark transaction as not needing receipt
- `remove_no_receipt_category` - Remove category from transaction

## Example Conversations

**User:** "Show me incomplete transactions from last month"
```
Claude uses: list_transactions with isComplete=false, dateFrom, dateTo
```

**User:** "Match all my unconnected receipts"
```
Claude uses: auto_connect_file_suggestions
```

**User:** "The bank fee doesn't need a receipt"
```
Claude uses: list_no_receipt_categories, then assign_no_receipt_category
```

## API Key Security

- API keys are hashed before storage (we never store the raw key)
- Keys can be revoked anytime in Settings
- Each key tracks last used time and usage count
- Maximum 5 active keys per user
- Optional expiry dates supported

## Domain Context

The plugin includes a skills file (`skills/fibuki-guide/SKILL.md`) that gives Claude context about:
- FiBuKI's data model (sources, transactions, files, partners)
- Transaction completion logic
- Amount handling (cents, not euros!)
- Common workflows
