# Workstream: FiBuKI as an OpenAI plugin (ChatGPT + Codex)

**Status:** Scoped 2026-10-02, not started. Written to be handed to a cheaper
model session. Felix's brief: "rather less features but great embedded execution
over complex logic", pre-accounting UX first, use the mail and file services the
user already connected, maybe the browser. **A skill package, not new FiBuKI logic.**

## Read first

1. [`docs/who-is-this-for.md`](../docs/who-is-this-for.md): Austrian EPU, pre-accounting
   only, the Tax Advisor is a gatekeeper. The plugin's job is "the pile turns into
   something the Steuerberater can use", nothing else.
2. [`CONTEXT.md`](../CONTEXT.md): use its terms (File, Transaction, Match, Partner,
   No-document Category, Coverage, Documentation State, Accepted Receipt).
3. [`integrations/openclaw-plugin/skills/fibuki-guide/SKILL.md`](../integrations/openclaw-plugin/skills/fibuki-guide/SKILL.md):
   the existing skill for OpenClaw. Same API, reuse its rules (cents, sign, no
   transaction deletion, trust server scores).
4. OpenAI plugin examples: `git clone --depth 1 https://github.com/openai/plugins`.
   Study `plugins/notion` (skills + own MCP + app), `plugins/data-analytics`
   (optional third-party apps in `.app.json`), `plugins/codex-security`
   (bundled `scripts/`, `app://` links inside a SKILL.md). `developers.openai.com`
   was blocked from the scoping session's network, so the format below was read
   off those examples, not the docs. Verify against the docs if you can reach them.

## What a plugin is (as of the examples)

```
<plugin>/
  .codex-plugin/plugin.json   name, version, description, interface{displayName,
                              shortDescription, longDescription, category, capabilities,
                              defaultPrompt[], brandColor, logo, composerIcon,
                              privacyPolicyURL, termsOfServiceURL, websiteURL},
                              "skills": "./skills/", "mcpServers": "./.mcp.json",
                              "apps": "./.app.json"
  .mcp.json                   {"mcpServers": {"fibuki": {"type": "http", "url": "..."}}}
  .app.json                   {"apps": {"gmail": {"id": "connector_...", "optional": true}, ...}}
  skills/<name>/SKILL.md      frontmatter: name, description (+ metadata.short-description)
  skills/<name>/agents/openai.yaml   interface: display_name, short_description, default_prompt
  skills/<name>/references/*.md      loaded on demand
  skills/<name>/evaluations/*.json   {name, skills, query, expected_behavior[], success_criteria[]}
  scripts/                    helpers the skills run (Codex has a shell; ChatGPT does not)
  assets/
```

Inside a SKILL.md another app is linked as `[$gmail](app://connector_2128aebfecb84f64a069897515042a44)`.

Connector ids seen in the examples (copy from the cloned repo, do not retype):

| App | id |
|---|---|
| Gmail | `connector_2128aebfecb84f64a069897515042a44` |
| Outlook Email | `connector_4aaab2856305417b993eca9a216aaf6e` |
| Google Drive | `connector_5f3c8c41a1e54ad7a76272c89e2554fa` |
| SharePoint / OneDrive | `connector_1e4f6a44acf14e3ca1d96672f8c945bc` |
| Dropbox | `asdk_app_69b31dc2110c8191b8b47dc98fe5a052` |

All of them go in `.app.json` with `"optional": true`. FiBuKI is the only required server.

## The product: three skills, one loop

Fewer features, each one finished. Everything goes through the existing MCP tools
(`functions/src/tools/definitions.ts`, 59 tools). No scoring, matching or
extraction runs in the plugin: FiBuKI already does upload, extraction, Partner match
and Transaction suggestions server side the moment a File lands.

### 1. `fibuki-belege` (flagship): "Get my month ready for the Steuerberater"

Default prompts: "Mach meinen September fertig", "Which payments are still missing
an invoice?", "Find the invoices for last month and match them".

Loop, for a period the user names (default: last full month):

1. **Status.** `get_automation_status` (plan, features), then
   `list_transactions_needing_files` for the period. Open with one short table:
   N Transactions, X covered, Y missing a File, Z with a suggestion waiting.
2. **Harvest what FiBuKI already found.** For Files with `transactionSuggestions`
   at Confidence >= 85 (server Score, never re-scored here), show them as a batch
   and connect on one confirmation (`connect_file_to_transaction` or
   `auto_connect_file_suggestions`). If FiBuKI has its own Mail Integration, its
   Sync has already done most of the work; say so and do not search mail twice.
3. **Hunt the gaps** in the connected apps, in this order, stopping per
   Transaction at the first hit: Gmail / Outlook (search by Partner name, amount
   in both `12,34` and `12.34`, date window -7..+30 days, words "Rechnung",
   "Invoice", "Beleg", "Receipt"), then Drive / OneDrive / Dropbox (same terms,
   PDF and image only). Put the search recipe in `references/invoice-hunting.md`.
4. **Upload** each found document to FiBuKI (`upload_file`; see the transfer
   section for how bytes move per surface). Byte-identical re-uploads return
   `duplicate: true`, so retries are safe. Then wait briefly and re-read the File:
   FiBuKI's own pipeline suggests the Match. Connect on confirmation.
5. **Resolve the rest without a document.** Bank fees, transfers between own
   accounts, payroll, taxes: offer `list_no_receipt_categories` +
   `assign_no_receipt_category`. Never guess a Category silently.
6. **Close-out summary**: what was matched, what is still missing (with Partner,
   amount, date, so the user can go fetch it), and a link to the FiBuKI
   transactions view for the period.

UX rules that make it feel good:
- One confirmation per batch, never per item. Show the batch as a compact table.
- Amounts in Euro with a comma for German users (`12,34 €`), stored in cents.
- Speak the user's language (German or English), FiBuKI vocabulary per ADR-0007.
- Never delete a Transaction; if asked, explain why (CLAUDE.md, "Transaction Deletion NOT Allowed").
- Feature gate: `upload_file` needs the `fileUpload` feature and matching tools need
  `aiMatching`. On a gate error, explain the plan limit once and continue with
  what is allowed (reading, categorising).

### 2. `fibuki-bank-csv`: "Import this bank export"

User drops a CSV from George (Erste), Raiffeisen ELBA, Bank Austria, BAWAG, N26,
Revolut or Wise.

1. `list_sources`; pick or `create_source` the Bank Account (ask, never assume).
2. Detect the format. `references/austrian-bank-csvs.md` lists per bank: encoding
   (often Windows-1252), delimiter (`;`), decimal comma, date format, which column
   is payee / reference / IBAN. Show a 5-row preview of the mapping.
3. On confirmation convert and send with `import_transactions` in chunks of 200.
   Amount and date parsing is **not** done by the model: it uses
   `scripts/csv-to-transactions.mjs` (see below), which bundles FiBuKI's own
   `lib/import/{csv-parser,amount-parsers,date-parsers}.ts` via esbuild. Port,
   never regenerate (rewrite-goals.md).
4. Report: N imported, M skipped as duplicates, then offer to run skill 1 on the
   new period.

### 3. `fibuki-connect`: setup and status

Only for the first run or when a tool call fails with an auth error. Codex:
`npx @fibukiapp/cli auth --format env` (existing device flow, writes `fk_...`).
ChatGPT: the OAuth flow (Phase 3). Ends with `get_automation_status`.

The browser is **not** a fourth skill. In `invoice-hunting.md`, for portals that
only show invoices after login (A1, Magenta, Wiener Netze, AWS, Google Ads), tell
the user to use the FiBuKI browser extension (`/integrations/browser`, it already
records and replays portal recipes and uploads PDFs). In Codex, its built-in browser
may be used to download into a folder that skill 1 then uploads. Nothing more.

## How bytes move (the one hard part)

`upload_file` takes `url` or `base64`. A model cannot pipe a 2 MB PDF through its
own context as base64, so per surface:

| Surface | Source | Path |
|---|---|---|
| Codex | local file, CSV, browser download | `scripts/fibuki-upload.mjs <path...>`: reads `FIBUKI_API_KEY`, POSTs `upload_file` with base64 to `https://fibuki.com/api/mcp`. Plugin-side helper, no FiBuKI change. |
| Codex | Gmail / Drive attachment via connector | Spike: does the connector return bytes or a fetchable link? If it can save to disk, use the script. |
| ChatGPT | file the user attaches in chat | Apps SDK file params: the tool receives a short-lived download URL, passed to `upload_file.url`. Needs a `_meta` entry on the `upload_file` definition (Phase 3). |
| ChatGPT | Gmail / Drive attachment via connector | Spike. If no URL can be obtained, the skill says "FiBuKI can read your mailbox directly" and links the Mail Integration setup instead. This is the honest fallback, and it is FiBuKI's strongest path anyway. |

## Phases (each one is a separate small session)

### Phase 0: spike (half a day, no product code)
- Point Codex at `https://fibuki.com/api/mcp/sse` with a bearer `fk_` key and confirm
  `initialize`, `tools/list` and `tools/call list_sources`. Known risk: `mcpSse`
  (`functions/src/mcp-api/mcp-sse.ts`) is plain JSON-RPC over POST and answers
  protocol `2024-11-05`; a streamable-HTTP client may want a newer version echo, a
  `202` for `notifications/initialized`, or `Mcp-Session-Id`. Write down exactly what
  breaks. If something does, fixing it is a small, separate PR on `mcp-sse.ts`
  with a test; that is transport plumbing, not domain logic.
- Find out how a plugin's `.mcp.json` passes a bearer token from an env var in Codex.
- Find out what the Gmail and Drive connectors return for an attachment.
- Output: a short outcome note appended to this file.

### Phase 1: Codex plugin, skills only (the main deliverable)
- New folder `integrations/openai-plugin/` (sibling of `openclaw-plugin/`), the
  layout above, the three skills, `references/`, `scripts/fibuki-upload.mjs`,
  `scripts/csv-to-transactions.mjs` (esbuild bundle of `lib/import`, built by an
  npm script in that folder, output committed or built on release; pick one and say why).
- Evaluations per skill in `evaluations/*.json`, at least: month close with 3
  Gmail hits + 1 bank fee; month close on a plan without `fileUpload`; George CSV
  in Windows-1252; asking to delete a Transaction.
- A test for `csv-to-transactions.mjs` against 2 real-shaped fixtures (George,
  N26), anonymised. Scoped: `npx vitest run <file> --pool=forks --maxWorkers=1`.
- README with install steps for Codex (local marketplace path).
- **Zero changes outside `integrations/openai-plugin/`** except the Phase 0 transport
  fix if one was needed.

### Phase 2: polish from real use
Run skill 1 on Felix's own last month. Fix the prompts, not the server. Track
what users ask for that the tools cannot do; that list is the input for any later
server work, decided by Felix, not by the implementing session.

### Phase 3: ChatGPT distribution (needs server work, own ticket each)
1. **OAuth for MCP.** ChatGPT cannot use `fk_` keys. Better Auth is already the
   self-host auth (`functions/src/selfhost/better-auth.ts`, JWT/JWKS on); its MCP /
   OIDC provider plugin is not enabled. Needs protected-resource metadata, an
   authorization server, client registration, and mapping the token to the same
   user + scopes `validateApiKey` yields. Same feature on self-host (who-is-this-for:
   no cloud-only capability).
2. **File params on `upload_file`** so chat attachments arrive as a URL.
3. **SSRF guard first.** `upload_file` does an unrestricted `fetch(url)`
   (`functions/src/tools/handlers.ts:2864`). On the Hetzner box that can reach
   `fibuki-api`, Postgres and SeaweedFS on the compose network. Before any surface
   sends it third-party URLs, restrict it to https, public IPs, a size cap and a
   timeout. This is a real finding today, independent of the plugin.
4. App submission (privacy policy, screenshots, review).

## Non-goals
- No new MCP tools in Phase 1. No exposing `lib/agent/tools/*` (Gmail search,
  convertEmailToPdf) over MCP. No widgets / UI components.
- No scoring, matching, category or VAT logic in the plugin (CLAUDE.md, "Server-Side
  Scoring Only").
- No outgoing invoices (`create_invoice` etc.): FiBuKI is not an invoicing tool.
- No BMD export from the plugin. The export stays in FiBuKI, where it is tested.
- No Kanzlei / multi-client flows.

## Guardrails for the implementing session
- Host safety from CLAUDE.md: no full vitest, no project-wide tsc, no `next build`.
- Branch from `main`, small commits, self-review the PR.
- Every write the skills make must be one the user confirmed in that turn's batch.
- If a step seems to need server logic, stop and write it down here instead.
</content>
</invoke>
