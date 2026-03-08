# European Bank Transaction Analyzer (FiBuKI OpenClaw Plugin)

Give your AI agent access to European bank transactions via PSD2 Open Banking. Uses FiBuKI.com connections to browse accounts, search payments, auto-match receipts to transactions, categorize expenses, and manage business partners. 25 tools.

## Installation

### From ClawHub (recommended)

```bash
clawhub install fibuki
```

### From npm

```bash
openclaw plugins install @fibukiapp/openclaw-plugin
```

### Local development

```bash
cd integrations/openclaw-plugin
openclaw plugins install -l .
```

## Configuration

### 1. Get an API Key

**Option A — CLI (zero friction):**
```bash
npx @fibukiapp/cli auth
```
Opens your browser, you approve, key is saved automatically.

**Option B — Manual:**
1. Go to **fibuki.com > Settings > Integrations > AI Agents**
2. Click "Create API Key"
3. Copy the key (starts with `fk_`)

### 2. Configure OpenClaw

**Option A — Environment variable** (works with ClawHub skills):
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

## What Claude Can Do

| Task | Tools Used |
|------|------------|
| **View bank accounts** | `list_sources`, `get_source` |
| **Browse transactions** | `list_transactions`, `get_transaction` |
| **Find incomplete work** | `list_transactions` (isComplete=false), `list_transactions_needing_files` |
| **Match receipts** | `list_files`, `connect_file_to_transaction`, `auto_connect_file_suggestions` |
| **Categorize transactions** | `list_no_receipt_categories`, `assign_no_receipt_category` |
| **Manage partners** | `list_partners`, `create_partner`, `assign_partner_to_transaction` |
| **Import data** | `import_transactions`, `upload_file` |

## Resources

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

## Domain Context

The plugin includes a skill file (`skills/fibuki-guide/SKILL.md`) that gives the agent context about FiBuKI's data model, transaction completion logic, amount handling (cents, not euros!), and common workflows.
