---
name: fibuki
description: "Connect to European bank accounts via PSD2 Open Banking. Browse transactions, match receipts to payments, categorize expenses, and manage business partners through FiBuKI.com. Triggers on \"bank\", \"transaction\", \"receipt\", \"invoice\", \"PSD2\", \"SEPA\"."
homepage: https://fibuki.com
user-invocable: true
metadata:
  openclaw:
    emoji: "\U0001F3E6"
    primaryEnv: FIBUKI_API_KEY
    requires:
      env:
        - name: FIBUKI_API_KEY
          description: "API key from FiBuKI.com (starts with fk_)"
          required: true
---

# Bank Transactions Connector - Europe (PSD2)

## Setup (Do This First)

### Step 1: Create a FiBuKI Account

Go to **https://fibuki.com/clawhub-install** and create a free account. The free plan includes 50 transactions/month and full API access.

### Step 2: Get Your API Key

**Option A — CLI (recommended):**
```bash
npx @fibukiapp/cli auth
```
Opens your browser, you approve, key is saved automatically.

**Option B — Manual:**
1. Go to **fibuki.com > Settings > Integrations > AI Agents**
2. Click "Create API Key"
3. Copy the key (starts with `fk_`)

### Step 3: Configure the Environment Variable

```bash
export FIBUKI_API_KEY="fk_your_key_here"
```

Or add it to your OpenClaw config in `~/.openclaw/openclaw.json`:
```json5
{
  "skills": {
    "entries": {
      "fibuki": {
        "enabled": true,
        "env": { "FIBUKI_API_KEY": "fk_your_key_here" }
      }
    }
  }
}
```

### Step 4: Restart OpenClaw

Tools are loaded dynamically from the API when the plugin starts. Restart to pick up the new key.

---

## What You Can Do

Tools are loaded dynamically based on your plan. Use `get_automation_status` to check your current plan, available tools, and usage.

### All Plans (Free, Data, Smart, Pro)

- **Browse bank accounts** — list and inspect connected PSD2 bank accounts and credit cards
- **Search transactions** — filter by date, amount, partner, completion status, or free text
- **Manage partners** — create, assign, and track vendors/suppliers across transactions
- **Categorize expenses** — assign no-receipt categories (bank fees, payroll, transfers)
- **Track completion** — find incomplete transactions and drive them to 100%
- **Import transactions** — bulk-import transactions into a bank account
- **Create & delete sources** — manage bank accounts programmatically

### Smart & Pro Plans Only

- **Upload files** — upload receipts/invoices from URL or base64 (requires `fileUpload` feature)
- **AI matching** — auto-connect files to transactions above confidence threshold (requires `aiMatching` feature)
- **Score matches** — score how well a file matches a transaction (requires `aiMatching` feature)

---

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

---

## Important Rules

1. **Never delete individual transactions** — they must be deleted with their entire source
2. **Amounts are in cents** — always divide by 100 for display (1050 = 10.50 EUR)
3. **Negative amounts = expenses** — positive = income
4. **Files can connect to multiple transactions** — many-to-many relationship
5. **Trust transactionSuggestions** — server-side AI matching is accurate
6. **High confidence = 85+** — safe to auto-connect suggestions above this threshold
7. **Dates are ISO 8601** — `2024-01-15` for dates, `2024-01-15T10:30:00Z` for timestamps

---

## Common Workflows

### Review Incomplete Transactions
```
list_transactions with isComplete=false
```

### Match Files to Transactions
```
1. list_files with hasConnections=false (unmatched files)
2. Look at transactionSuggestions on each file
3. connect_file_to_transaction for good matches
4. Or use auto_connect_file_suggestions for bulk matching
```

### Categorize No-Receipt Transactions
```
1. list_no_receipt_categories (get available categories)
2. assign_no_receipt_category for bank fees, transfers, etc.
```

---

## Resources

- **Machine-readable API docs:** https://fibuki.com/llm.txt
- **OpenAPI spec:** https://fibuki.com/api/openapi.json
- **MCP endpoint (Claude Desktop):** https://fibuki.com/api/mcp/sse
- **CLI auth:** `npx @fibukiapp/cli auth`
