# Bank Transactions Connector - Europe (PSD2)

Connect your AI agent to European bank accounts via PSD2 Open Banking. Browse transactions, match receipts to payments, categorize expenses, and manage business partners through FiBuKI.com.

## Setup

### 1. Create a FiBuKI Account

Go to **https://fibuki.com/clawhub-install** — the free plan includes 50 transactions/month and full API access.

### 2. Get an API Key

**Option A — CLI (recommended):**
```bash
npx @fibukiapp/cli auth
```
Opens your browser, you approve, key is saved automatically.

**Option B — Manual:**
1. Go to **fibuki.com > Settings > Integrations > AI Agents**
2. Click "Create API Key"
3. Copy the key (starts with `fk_`)

### 3. Install the Plugin

**From ClawHub:**
```bash
clawhub install fibuki
```

**From npm:**
```bash
openclaw plugins install @fibukiapp/openclaw-plugin
```

### 4. Configure

**Option A — Environment variable:**
```bash
export FIBUKI_API_KEY="fk_your_key_here"
```

**Option B — Plugin config** in `~/.openclaw/openclaw.json`:
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

### 5. Restart OpenClaw

Tools are loaded dynamically from the API based on your plan.

## What Your Agent Can Do

### All Plans
| Task | Examples |
|------|---------|
| **View bank accounts** | `list_sources`, `get_source` |
| **Browse transactions** | `list_transactions`, `get_transaction` |
| **Find incomplete work** | `list_transactions_needing_files` |
| **Categorize transactions** | `assign_no_receipt_category` |
| **Manage partners** | `create_partner`, `assign_partner_to_transaction` |
| **Import data** | `import_transactions` |

### Smart & Pro Plans
| Task | Examples |
|------|---------|
| **Upload receipts** | `upload_file` |
| **AI matching** | `auto_connect_file_suggestions`, `score_file_transaction_match` |

## Rate Limits

| Plan | Per minute | Per hour |
|------|-----------|----------|
| Free | 10 | 100 |
| Data | 60 | 1,000 |
| Smart | 120 | 5,000 |
| Pro | 120 | 5,000 |

## Resources

- **Landing page** — https://fibuki.com/clawhub-install
- **llm.txt** — Machine-readable API overview: https://fibuki.com/llm.txt
- **OpenAPI spec** — Full tool schema: https://fibuki.com/api/openapi.json
- **MCP endpoint** — For Claude Desktop: https://fibuki.com/api/mcp/sse
- **CLI** — `npx @fibukiapp/cli auth` for zero-friction setup

## API Key Security

- API keys are hashed before storage (we never store the raw key)
- Keys can be revoked anytime in Settings
- Each key tracks last used time and usage count
- Maximum 5 active keys per user
- Optional expiry dates supported

## Local Development

```bash
cd integrations/openclaw-plugin
openclaw plugins install -l .
```
