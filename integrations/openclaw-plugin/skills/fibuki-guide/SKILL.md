---
name: fibuki
description: "Analyze European bank transactions and match receipts via PSD2 Open Banking. Connect to bank accounts through FiBuKI.com, browse transactions, auto-match invoices to payments, categorize expenses, and manage business partners. Triggers on \"bank\", \"transaction\", \"receipt\", \"invoice\", \"bookkeeping\", \"PSD2\"."
homepage: https://fibuki.com
user-invocable: true
metadata: {"openclaw":{"emoji":"🏦","primaryEnv":"FIBUKI_API_KEY","requires":{"env":["FIBUKI_API_KEY"],"bins":["curl"]}}}
---

# European Bank Transaction Analyzer

You have access to European bank transactions and receipt matching through FiBuKI.com. FiBuKI uses PSD2 Open Banking connections to pull live bank data and provides AI-powered receipt-to-payment matching for small businesses and freelancers.

## What You Can Do

- **Access PSD2 bank accounts** — browse connected European bank accounts and credit cards
- **Search & filter transactions** — by date range, amount, partner, completion status, or free text
- **Match receipts to payments** — connect uploaded invoices/receipts to bank transactions using AI confidence scoring
- **Auto-match in bulk** — let the AI engine connect high-confidence receipt-to-transaction matches automatically
- **Categorize expenses** — assign no-receipt categories (bank fees, payroll, internal transfers) to complete bookkeeping
- **Track completion** — find incomplete transactions and drive them to 100%
- **Manage business partners** — create, assign, and track vendors/suppliers across transactions

## Authentication

All API calls use the user's `FIBUKI_API_KEY` environment variable (starts with `fk_`).

Generate a key at: fibuki.com > Settings > Integrations > AI Agents
Or run: `npx @fibukiapp/cli auth`

Machine-readable API docs: https://fibuki.com/llm.txt

## API Endpoint

POST https://fibuki.com/api/mcp
Headers: Authorization: Bearer $FIBUKI_API_KEY, Content-Type: application/json
Body: { "tool": "<tool_name>", "arguments": { ... } }

## Core Data Model

### Sources (Bank Accounts)
- Represent bank accounts or credit cards
- Transactions are imported from sources
- Types: `bank_account`, `credit_card`

### Transactions
- Individual bank movements (debits/credits)
- Have: date, amount (in cents!), name, partner
- **Cannot be individually deleted** (accounting integrity)
- **Complete** when they have a file attached OR a no-receipt category assigned

### Files (Receipts/Invoices)
- Uploaded PDFs or images
- AI extracts: amount, date, VAT, partner name
- System suggests matching transactions with confidence scores (0-100)
- Many-to-many relationship with transactions

### Partners
- Companies or people the user transacts with (e.g., "Amazon", "REWE")
- System auto-detects partners from transaction names

### No-Receipt Categories
- For transactions that legally don't need receipts: bank fees, interest, internal transfers, payroll, taxes
- Assigning a category marks the transaction complete

## Available Tools

### Bank Accounts
- `list_sources` — List all connected bank accounts
- `get_source(sourceId)` — Get details of a specific account
- `create_source(name, accountKind?, iban?, currency?)` — Create a new bank account
- `delete_source(sourceId, confirm)` — Delete account and all its data (requires confirm: true)

### Transactions
- `list_transactions(sourceId?, dateFrom?, dateTo?, search?, isComplete?, limit?)` — Search/filter transactions
- `get_transaction(transactionId)` — Get full transaction details
- `update_transaction(transactionId, description?, isComplete?)` — Update description or status
- `list_transactions_needing_files(minAmount?, limit?)` — Find transactions without receipts or categories
- `import_transactions(sourceId, transactions[])` — Import transactions into a source

### Files (Receipts/Invoices)
- `list_files(hasConnections?, hasSuggestions?, limit?)` — List uploaded files
- `get_file(fileId)` — Get file details including AI-extracted data and suggestions
- `connect_file_to_transaction(fileId, transactionId)` — Link file to transaction (marks it complete)
- `disconnect_file_from_transaction(fileId, transactionId)` — Unlink file from transaction
- `auto_connect_file_suggestions(fileId?, minConfidence?)` — Bulk-connect high-confidence matches (default 89%)
- `upload_file(fileName, mimeType, url?, base64?)` — Upload a file from URL or base64
- `score_file_transaction_match(fileId, transactionId)` — Score how well a file matches a transaction

### Partners
- `list_partners(search?, limit?)` — List user partners
- `get_partner(partnerId)` — Get partner details
- `create_partner(name, aliases?, vatId?, ibans?, website?, country?)` — Create a new partner
- `assign_partner_to_transaction(transactionId, partnerId)` — Assign partner to transaction
- `remove_partner_from_transaction(transactionId)` — Remove partner assignment

### Categories
- `list_no_receipt_categories` — List available no-receipt categories
- `assign_no_receipt_category(transactionId, categoryId)` — Assign category (marks complete)
- `remove_no_receipt_category(transactionId)` — Remove category

### Status
- `get_automation_status` — Get user's automation mode, AI budget, and plan info

## Common Workflows

### 1. Review Incomplete Transactions
```
list_transactions with isComplete=false
```

### 2. Match Files to Transactions
```
1. list_files with hasConnections=false (unmatched files)
2. Look at transactionSuggestions on each file
3. connect_file_to_transaction for good matches
4. Or use auto_connect_file_suggestions for bulk matching
```

### 3. Categorize No-Receipt Transactions
```
1. list_no_receipt_categories (get available categories)
2. assign_no_receipt_category for bank fees, transfers, etc.
```

### 4. Find Transactions Needing Receipts
```
list_transactions_needing_files
```

## Important Rules

1. **Never delete individual transactions** — they must be deleted with their entire source
2. **Amounts are in cents** — always divide by 100 for display (1050 = 10.50 EUR)
3. **Negative amounts = expenses** — positive = income
4. **Files can connect to multiple transactions** — many-to-many relationship
5. **Trust transactionSuggestions** — server-side AI matching is accurate
6. **High confidence = 85+** — safe to auto-connect suggestions above this threshold
7. **Dates are ISO 8601** — `2024-01-15` for dates, `2024-01-15T10:30:00Z` for timestamps
