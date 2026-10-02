# Workstream: FiBuKI as an OpenAI plugin (ChatGPT + Codex)

**Status (2026-10-02, v3):** Phase 1 (MCP server modernised) is DONE on branch
`claude/sharp-meitner-w8f2qf`. Felix's decisions are recorded below. Next: Phase 2
(Codex plugin, skills only) and Phase 3 (onboarding simplification), one session each.

Felix's brief: fewer features, great embedded execution, use the mail and file
services the user already connected, maybe the browser, onboarding parity between
fibuki.com and the plugin.

**Scope rule.** The plugin is skills + widgets on top of FiBuKI's existing tools.
FiBuKI changes are limited to MCP plumbing (transport, auth, widget resources) and
the onboarding simplification Felix asked for. No new scoring, matching, extraction
or VAT logic anywhere.

## Read first

1. [`docs/who-is-this-for.md`](../docs/who-is-this-for.md): Austrian EPU, pre-accounting
   only, Tax Advisor is a gatekeeper, same features on self-host and cloud.
2. [`CONTEXT.md`](../CONTEXT.md): use its terms (File, Transaction, Match, Partner,
   No-document Category, Coverage, Mail Integration, Sync).
3. [`integrations/openclaw-plugin/skills/fibuki-guide/SKILL.md`](../integrations/openclaw-plugin/skills/fibuki-guide/SKILL.md):
   existing OpenClaw skill; reuse its rules.
4. OpenAI docs. `developers.openai.com` is blocked for the WebFetch tool in the
   cloud environment but **reachable with `curl`**. Read at least:
   `/plugins/build/plugins`, `/plugins/build/mcp-server`, `/plugins/build/auth`,
   `/plugins/build/chatgpt-ui`, `/plugins/build/extensions`,
   `/plugins/guides/submit-claude-plugin`. Examples: `git clone --depth 1 https://github.com/openai/plugins`.

## Decisions (Felix, 2026-10-02)

1. **Signup via Connect.** The OAuth authorize page is FiBuKI's normal sign-in /
   sign-up. Build it from the existing ChatGPT integration page
   (`app/(dashboard)/integrations/chatgpt/page.tsx`, today an outdated OpenAPI
   "Actions" guide) and the Claude one (`integrations/claude-mcp`).
2. **No accounting year.** Dropped.
3. **Mail:** suggest FiBuKI's own Mail Integration (it runs async in the background);
   the user may instead let ChatGPT / Claude fetch from their connected mail, since
   those also run async now. Both are fine; the skill offers the choice.
4. **Everyone is full service.** The track choice (`full_service` / `data_only`)
   goes away. One onboarding.

## Phase 1 (DONE): MCP server modernised

What changed:
- `functions/src/mcp-api/mcp-server.ts` (new): official `@modelcontextprotocol/sdk`
  1.31, low-level `Server` + `WebStandardStreamableHTTPServerTransport`, stateless,
  JSON responses. Protocol 2025-11-25 with fallback to every older version the SDK
  supports, including the 2024-11-05 the old server spoke. Server `instructions`
  (book-protecting rules in the first 512 chars), tool `title` + `annotations`,
  `structuredContent` next to the text block, tool failures as `isError` (model can
  recover), unknown tool as `-32602`. `requiredFeature` moved to
  `_meta["fibuki/requiredFeature"]`.
- `functions/src/mcp-api/tool-annotations.ts` (new): every tool classified read-only /
  write / destructive; a test fails when a new tool is added without a decision.
- `functions/src/mcp-api/mcp-sse.ts`: now only the HTTP edge (CORS incl. MCP headers,
  API-key auth with `WWW-Authenticate` on 401, GET event stream -> 405, DELETE -> 405,
  plain GET info kept, Accept header filled in for old clients).
- `app/api/mcp/sse/route.ts`: transparent proxy; forwards MCP headers, passes status,
  headers and body through (the old proxy turned the empty 202 for notifications into a 500).
- URL unchanged: `https://fibuki.com/api/mcp/sse`. Tools, handlers, auth unchanged.
- Tests: `mcp-server.test.ts`, `mcp-sse.test.ts` (20, incl. a real SDK client over
  Express). Functions suite 2271 passed, self-host suite 991 passed, both tsc clean, lint clean.
  `next build` was not run.

Still open on the server (Phase 4): OAuth, widgets, profile tool, SSRF guard.

## What the docs confirmed (curl, 2026-10-02)

- **Packaging.** Portable Agent Plugins format: `plugin.json` at the root with
  `"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"`, skills
  under `skills/<name>/SKILL.md`, `mcp.json` (own schema, not a renamed `.mcp.json`),
  OpenAI-specific bits under `extensions.com.openai`. `.codex-plugin/plugin.json`
  is the older compatibility form. One package can hold skills + MCP server, and the
  submit guide covers converting a Claude plugin, so **one package can serve Claude and OpenAI**.
- **MCP server requirements.** Streamable HTTP at a stable public URL, explicit
  schemas, accurate annotations, server instructions. Phase 1 covers these.
- **Auth.** OAuth 2.1 per MCP spec: `/.well-known/oauth-protected-resource` on the
  MCP server, authorization server metadata with `code_challenge_methods_supported: ["S256"]`,
  client registration by CIMD (preferred, `client_id_metadata_document_supported: true`,
  token auth `none` or `private_key_jwt`) or DCR, echo the `resource` parameter into
  the token `aud`, RFC 9207 `iss` in authorization responses for the stable redirect
  `https://chatgpt.com/connector_platform_oauth_redirect`. Recommended: a profile tool
  marked `_meta["openai/profile"]: true` returning a stable opaque id.
- **Widgets (MCP Apps).** Tool `_meta.ui.resourceUri` -> a `ui://` resource with mime
  `text/html;profile=mcp-app` (`openai/outputTemplate` is a compatibility alias).
  Bridge is `ui/*` JSON-RPC over postMessage; `window.openai` adds `callTool`,
  `sendFollowUpMessage`, `widgetState`, **`uploadFile`, `selectFiles`,
  `getFileDownloadUrl`**, `requestModal`. Display modes: inline, fullscreen,
  picture-in-picture. UI kit: `@openai/apps-sdk-ui`.
- **Extensions** (`@openai/mcp-extensions`): sidebar apps, conversation side panel,
  plugin settings, **file viewers** (open a file type in our UI), deep links, rich
  forms, and **plugin onboarding** ("guide users through setup in a new or existing
  conversation"). Read that extension's spec before designing Phase 4's onboarding card.

## The experience

### Registration (Decision 1)

1. User installs the plugin and clicks **Connect** (ChatGPT), or the Claude connector.
2. OAuth popup opens FiBuKI's sign-in. New users sign up there (Google one-click).
   No account is ever created by a tool call.
3. **Onboarding inside the popup runs only until identity is set** (name, company,
   UID, own IBANs, own emails), because without identity the user's own issued
   invoices get matched as incoming.
4. Consent, then the **handshake page**: "Connected to ChatGPT. Go back to ChatGPT, or
   stay in FiBuKI." Back returns to the OAuth redirect; Stay lands in the dashboard
   with the rest of the onboarding checklist.
5. FiBuKI records `origin` (`chatgpt`, `codex`, `claude`, `web`) on the onboarding doc,
   taken from the OAuth client that started the flow (not the Referer header).

Signup policy for strangers: FiBuKI is invite-only (`allowedEmails`, open seats in
`functions/src/auth/openSeats.ts`, access requests). Recommended: plugin-origin
signups claim an open seat, else a friendly access-request page. Confirm with Felix in Phase 4.

### Onboarding (Decision 4)

One checklist, same state and same completion rules on both surfaces:

| Step (existing id) | In ChatGPT / Claude | On fibuki.com |
|---|---|---|
| `set_identity` | done in the OAuth popup | settings/identity |
| `add_bank_account` + `import_transactions` | drop a CSV (skill `fibuki-bank-csv`), or deep link for PSD2 | sources |
| `connect_email` | offer the choice: FiBuKI Mail Integration (recommended, async) or let the assistant fetch from its own connected mail | integrations/gmail |
| `assign_partner` + `attach_file` | the Belege loop with the progress widget | transactions |

### The working loop

Skill `fibuki-belege`, "Mach meinen September fertig":
1. Status (progress widget): covered, missing, waiting suggestions.
2. Harvest FiBuKI's suggestions at Confidence >= 85, accepted in one batch. Never re-scored.
3. Hunt gaps in connected mail and file apps (Gmail / Outlook: Partner name, amount
   `12,34` and `12.34`, date -7..+30 days, "Rechnung", "Invoice", "Beleg"; then Drive /
   OneDrive / Dropbox). Login-only portals: the FiBuKI browser extension, or Codex's browser.
4. Upload; FiBuKI extracts and suggests; accept.
5. No-document lines via No-document Categories, proposed as a batch.
6. Close-out: what is still missing.

UX rules: one confirmation per batch; Euro with comma for German users; reply in the
user's language, ADR-0007 vocabulary; never delete a Transaction; on a plan-gate error
explain once and continue.

### Widgets (Phase 4, three only)

| Widget | Does |
|---|---|
| Onboarding card | the checklist; "do it here" or "open in FiBuKI" per row |
| Progress board | Coverage per month; fullscreen shows the missing list; picture-in-picture while the agent hunts. Includes a drop zone via `window.openai.uploadFile` / `selectFiles`, so "add files" is one drag. |
| Match review | File thumbnail, Partner, amount, date, Transaction, server Confidence; accept / reject per row and "accept all >= 85", calling the existing tools directly |

Possible later: a **file viewer** extension for `.csv` so opening a bank export in
ChatGPT shows FiBuKI's import preview.

## Plugin layout (Phase 2)

```
integrations/openai-plugin/          (portable Agent Plugins package)
  plugin.json                        $schema agent-plugins 1.0.0, name "fibuki",
                                     extensions.com.openai for interface metadata
  mcp.json                           fibuki -> https://fibuki.com/api/mcp/sse
  skills/fibuki-onboarding/          steps above
  skills/fibuki-belege/              the working loop, references/invoice-hunting.md
  skills/fibuki-bank-csv/            references/austrian-bank-csvs.md (George, ELBA,
                                     Bank Austria, BAWAG, N26, Revolut, Wise)
  each skill: SKILL.md, references/, evaluations/*.json
  scripts/fibuki-upload.mjs          Codex: local files -> upload_file (base64)
  scripts/csv-to-transactions.mjs    Codex: bundles lib/import parsers (port, never regenerate)
```

Optional apps the skills may use (ids from the examples repo): Gmail
`connector_2128aebfecb84f64a069897515042a44`, Outlook Email
`connector_4aaab2856305417b993eca9a216aaf6e`, Google Drive
`connector_5f3c8c41a1e54ad7a76272c89e2554fa`, SharePoint/OneDrive
`connector_1e4f6a44acf14e3ca1d96672f8c945bc`, Dropbox `asdk_app_69b31dc2110c8191b8b47dc98fe5a052`.
Check how the portable format declares optional apps (the examples use `.app.json`).

## Phases

- **Phase 1: MCP modernisation.** DONE (above).
- **Phase 2: plugin package, skills only.** Works in Codex now with an `fk_` key
  (`npx @fibukiapp/cli auth --format env`). Test with MCP Inspector and Codex. Evaluations:
  month close with 3 mail hits + 1 bank fee; plan without `fileUpload`; George CSV in
  Windows-1252; a request to delete a Transaction.
- **Phase 3: onboarding simplification (web, useful without the plugin).**
  - Remove the track choice (`components/onboarding/welcome-choice.tsx`, `types/onboarding.ts`).
  - Trial start: `setOnboardingTrackCallable.ts` starts the trial and derives
    `trialTier` from the track. Move the trial start to onboarding init with tier
    "smart" (everyone is full service). Existing `data_only` users keep working.
  - Move step completion from the client hook `hooks/use-onboarding.ts` to a server
    `get_onboarding_status` (ported rules + a shared test); step writes via callables
    instead of the direct client writes in `lib/operations/onboarding-ops.ts`.
  - Add `create_identity_entity` (only `update_identity_entity` exists).
  - Add `origin` and the origin-aware welcome copy (en + de).
- **Phase 4: ChatGPT / Claude connect.**
  - OAuth per the auth section above. Better Auth is the self-host auth
    (`functions/src/selfhost/better-auth.ts`); check its OAuth provider / MCP plugin
    for CIMD + DCR + `resource` + `iss` support before writing anything by hand. Same
    feature on self-host.
  - Authorize page = sign-in / sign-up + identity step + handshake page; rebuild
    `integrations/chatgpt` around it.
  - Profile tool with `_meta["openai/profile"]`.
  - **SSRF guard on `upload_file`** (unrestricted `fetch(url)` at
    `functions/src/tools/handlers.ts:2864`; on Hetzner it reaches fibuki-api, Postgres,
    SeaweedFS). https only, public IPs after DNS resolve, size cap, timeout. Do this
    before anything sends it third-party URLs; it is a real finding today.
  - Widgets + `get_period_status` (built from existing queries) + file params.
  - Submission.

## Non-goals
- No scoring, matching, Category or VAT logic in the plugin or widgets.
- No exposing `lib/agent/tools/*` over MCP. No outgoing invoices, no BMD export from
  the plugin, no Kanzlei flows. No more than three widgets.

## Guardrails
- Host safety from CLAUDE.md on small hosts.
- Branch from `main`, small commits, self-review the PR.
- Every write a skill makes is one the user confirmed in that turn's batch.
- If a step seems to need domain logic, stop and write it down here instead.
