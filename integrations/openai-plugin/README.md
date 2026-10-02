# FiBuKI plugin for ChatGPT, Codex and Claude

Pre-accounting for Austrian one-person businesses, from inside an AI assistant: set up, import a bank CSV, find and match the invoices for a month, hand the Steuerberater clean data.

This is a **skills-only plugin on top of FiBuKI's MCP server**. There is no FiBuKI logic in it: FiBuKI reads the documents, scores the matches and stores everything; the skills drive the loop and ask the user once per batch. Plan and decisions: [`handoffs/2026-10-02-openai-plugin.md`](../../handoffs/2026-10-02-openai-plugin.md).

```
plugin.json  mcp.json          portable Agent Plugins package (schemas validated)
skills/
  fibuki-onboarding/           identity, bank data, mailbox, first Belege
  fibuki-belege/               match a month, hunt missing invoices, close out
    references/invoice-hunting.md
  fibuki-bank-csv/             bank CSV -> Transactions
    references/austrian-bank-csvs.md
  (each: SKILL.md, agents/openai.yaml, evaluations/*.json)
scripts/
  fibuki-csv.mjs               GENERATED bundle of lib/import + src/csv-cli.ts
  fibuki-upload.mjs            local PDFs/images -> upload_file
src/csv-cli.ts  build.mjs      source and bundler for fibuki-csv.mjs
```

## Use it with Codex today (API key)

OAuth for the plugin comes with the ChatGPT work (phase 4). Until then Codex talks to FiBuKI with an API key.

1. Create a key: `npx @fibukiapp/cli auth --format env`, then `export FIBUKI_API_KEY=fk_...`. (Or Settings, Integrations, AI Agents on fibuki.com.)
2. Add FiBuKI's MCP server to `~/.codex/config.toml`:

   ```toml
   [mcp_servers.fibuki]
   url = "https://fibuki.com/api/mcp/sse"
   bearer_token_env_var = "FIBUKI_API_KEY"
   ```

3. Install the plugin from a local marketplace: put this folder at `<repo>/plugins/fibuki` and add to `<repo>/.agents/plugins/marketplace.json`:

   ```json
   {
     "name": "local-repo",
     "plugins": [
       {
         "name": "fibuki",
         "source": { "source": "local", "path": "./plugins/fibuki" },
         "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
         "category": "Finance"
       }
     ]
   }
   ```

4. Try: "Set me up with FiBuKI", "Mach meinen letzten Monat fertig", "Import my bank CSV".

Self-host: use your own URL in step 2 and set `FIBUKI_BASE_URL` for the scripts.

**Not yet verified in a real Codex or ChatGPT session.** Built and tested against the manifest schemas, the MCP server (a real SDK client over HTTP) and the scripts (fixtures and a fake API). First thing to check in Codex: that the bundled `mcp.json` server and your `config.toml` entry do not collide; if they do, drop one.

The skills use the connected mail and file apps of whichever assistant runs them (Gmail, Outlook, Google Drive, OneDrive, Dropbox). The plugin does not require them: without any, it still imports, matches what FiBuKI already has, and lists what is missing.

## The scripts

```bash
# what is in this file?
node scripts/fibuki-csv.mjs analyze export.csv [--skip N]

# dry run: converts, writes chunk files, prints totals and a preview. Sends nothing.
node scripts/fibuki-csv.mjs convert export.csv --date Buchungsdatum --amount Betrag \
  --name Buchungstext --partner Partnername --iban "Partner IBAN" --balance Saldo \
  --after 2026-08-31

# send it (FIBUKI_API_KEY, import_transactions in chunks under one import id, waits out
# rate limits). FiBuKI skips lines it already has; the result says how many (alreadyImported).
node scripts/fibuki-csv.mjs convert export.csv ... --import --source <sourceId>

# receipts and invoices
node scripts/fibuki-upload.mjs a1-rechnung.pdf bon.jpg
```

`fibuki-csv.mjs` is built from FiBuKI's own `lib/import` parsers, so it reads dates and amounts exactly as the web import does. On top of that it checks the result against every row: day/month order, the decimal mark, and (with `--balance`) that the running balance adds up. After changing `lib/import` or `src/csv-cli.ts`:

```bash
node integrations/openai-plugin/build.mjs         # rebuild the committed bundle
node integrations/openai-plugin/build.mjs --check # CI: fails when it is stale
node --test tests/openai-plugin-csv.test.mjs tests/openai-plugin-upload.test.mjs
```

## Known gaps

- **No shell, no CSV import.** Plain ChatGPT has no shell, so the CSV skill sends the user to the web import. A server tool that reuses the same parsers would close this (phase 4).
- **No tool creates an identity.** `update_identity_entity` only patches an existing one, so a brand new user sets their identity on fibuki.com until `create_identity_entity` exists (phase 3).
- **No tool lists Postfächer**, so the skills ask the user.
- **Bank layouts are modelled, not collected.** Add anonymised real exports to `tests/fixtures/openai-plugin` and extend `references/austrian-bank-csvs.md`.
