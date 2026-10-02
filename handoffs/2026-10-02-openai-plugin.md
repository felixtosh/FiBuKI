# Workstream: FiBuKI as an OpenAI plugin (ChatGPT + Codex)

**Status:** Scoped 2026-10-02 (v2, after Felix's onboarding notes), not started.
Written to be handed to a cheaper model session, one phase per session.

Felix's brief: "rather less features but great embedded execution over complex
logic", a great pre-accounting experience, use the mail and file services the user
already connected, maybe the browser, and **onboarding parity** between fibuki.com
and the plugin.

**Scope rule.** The plugin is skills + widgets on top of FiBuKI's existing tools.
FiBuKI changes are limited to (a) MCP plumbing (transport, auth, widget resources)
and (b) a short list of thin onboarding tools that Felix decides on first (see
"Decisions"). No new scoring, matching, extraction or VAT logic anywhere.

## Read first

1. [`docs/who-is-this-for.md`](../docs/who-is-this-for.md): Austrian EPU, pre-accounting
   only, the Tax Advisor is a gatekeeper. Same features on self-host and cloud.
2. [`CONTEXT.md`](../CONTEXT.md): use its terms (File, Transaction, Match, Partner,
   No-document Category, Coverage, Documentation State, Mail Integration, Sync).
3. [`integrations/openclaw-plugin/skills/fibuki-guide/SKILL.md`](../integrations/openclaw-plugin/skills/fibuki-guide/SKILL.md):
   the existing OpenClaw skill. Reuse its rules (cents, sign, no Transaction
   deletion, trust server scores).
4. OpenAI plugin examples: `git clone --depth 1 https://github.com/openai/plugins`.
   Study `plugins/notion` (skills + own MCP + app), `plugins/data-analytics`
   (optional third-party apps in `.app.json`), `plugins/codex-security`
   (bundled `scripts/`, `app://` links inside a SKILL.md). `developers.openai.com`
   was blocked from the scoping session's network: everything below about the plugin
   format was read off those examples, and everything about widgets and auth is from
   the MCP spec and Apps SDK as known in mid 2026. **Verify both in Phase 0.**

## Where things stand today (verified in code)

| Area | Today | Gap for ChatGPT |
|---|---|---|
| MCP endpoint | `functions/src/mcp-api/mcp-sse.ts`, hand-rolled JSON-RPC over POST, no SDK, protocol `2024-11-05`. Handles `initialize`, `tools/list`, `tools/call`, `ping`. Errors on `notifications/initialized`. Results are one text block of `JSON.stringify`. | Current spec is Streamable HTTP (2025-06-18 / 2025-11-25): `structuredContent` + `outputSchema`, tool `annotations` (`readOnlyHint`, `destructiveHint`), `resources/*` for widgets, `isError`, notifications answered with 202. |
| Auth | `fk_` API keys only (`functions/src/api-keys/index.ts`). CLI device flow at `app/api/auth/device/*`, approve page `app/auth/device/page.tsx`. | ChatGPT needs OAuth 2.1: protected-resource metadata, an authorization server, client registration (DCR or client metadata documents), PKCE. None exists. Better Auth (`functions/src/selfhost/better-auth.ts`) has JWT/JWKS on but no OAuth provider plugin. |
| Signup | Invite-only. Cloud: `validateRegistration` checks `allowedEmails`, else claims an open seat (`functions/src/auth/openSeats.ts`), else an access request. Self-host: `disableSignUp: true`, `assertInvited` hook. | A stranger clicking "Connect" in ChatGPT hits a wall unless we decide a policy (Decision 1). |
| Onboarding | State in `users/{uid}/settings/onboarding` (`types/onboarding.ts`). Tracks `full_service` (`set_identity`, `connect_email`, `add_bank_account`, `import_transactions`, `assign_partner`, `attach_file`) and `data_only`. Only `setOnboardingTrack` is a callable; step completion is **derived in the client hook** `hooks/use-onboarding.ts` from the user's data, and step writes are direct client Firestore writes (`lib/operations/onboarding-ops.ts`). | The plugin cannot see or advance onboarding. The derivation must move server side so both surfaces read one truth. |
| Identity | `users/{uid}/settings/userData` (`personalEntity`, `companies[]`, `ownEmails[]`). `onUserDataUpdate` creates identity Partners and recomputes invoice direction. MCP has `list_identity_entities` and `update_identity_entity` (patch only, fails if userData is missing). | No tool **creates** the identity, so a plugin-first user cannot set it up. |
| Accounting period | No user-level concept. Only per bank source `ApiSourceConfig.syncFromYear` (`types/banking-sync.ts:99`, default current year). CSV import keeps every row. | Felix wants a chosen year with a smart cutoff (Decision 2). |
| Upload | `upload_file` takes `url` or `base64`, does an **unrestricted `fetch(url)`** (`functions/src/tools/handlers.ts:2864`). | SSRF on the Hetzner compose network (fibuki-api, Postgres, SeaweedFS). Must be guarded before ChatGPT sends it file URLs. A real finding today, independent of the plugin. |

## The experience

### Registration: what "click the plugin" does

The common pattern for ChatGPT apps (Notion, Linear, Stripe all do this):

1. User installs the FiBuKI plugin and clicks **Connect**.
2. ChatGPT opens FiBuKI's OAuth authorize page on fibuki.com in a popup.
3. That page **is** FiBuKI's normal sign-in. A new user signs up there (Google
   one-click or email), an existing user signs in. No account is ever created by a
   tool call.
4. A consent screen ("ChatGPT wants to read and organise your Belege"), scopes map
   onto the existing API-key scopes.
5. Back in ChatGPT with a token. The first tool call is `get_onboarding_status`, and
   the onboarding card renders.

Codex is the same with the CLI device flow instead of the popup, until Codex can do
the OAuth flow too.

Self-host: the plugin's `.mcp.json` points at fibuki.com. Self-hosters override the
URL in their Codex / ChatGPT developer-mode config; the OAuth server is the same code
on their box. Document it, do not build anything special.

### Onboarding: one checklist, two surfaces

Same steps, same state, same completion rules in the web app and in the plugin.
The plugin uses the `full_service` track. Order (Felix's flow, mapped to existing step ids):

| # | Step | In ChatGPT | Hands off to fibuki.com when |
|---|---|---|---|
| 1 | Account | OAuth popup (above) | always (that is the popup) |
| 2 | **Identity** (`set_identity`) | Ask for name, company, UID (ATU...), own IBANs, own email addresses. Offer to read them off one of the user's **own issued invoices** (attached or from Drive) and confirm. Explain why in one line: "so your own invoices are never matched as incoming". | never |
| 3 | **Accounting year** (new, Decision 2) | "Which year are we preparing? 2025 or 2026?" Sets the cutoff. | never |
| 4 | **Bank data** (`add_bank_account`, `import_transactions`) | Either drop a CSV (skill `fibuki-bank-csv`, rows before the cutoff dropped) or connect the bank. | Bank connection (PSD2) needs a redirect: deep link to `/sources`, `syncFromYear` preset to the chosen year. |
| 5 | **Mailbox** (`connect_email`) | Recommend FiBuKI's own Mail Integration, because it keeps syncing in the background after the chat ends. ChatGPT's own Gmail / Outlook / Drive apps are the **gap filler** during a session (Decision 3). | Gmail OAuth / IMAP setup: deep link to `/integrations/gmail`. |
| 6 | **First matches** (`assign_partner`, `attach_file`) | The Belege loop below, with the progress widget. | never |

Each deep link returns the user to the chat. The checklist card re-reads
`get_onboarding_status` when it gets focus, so a step done on fibuki.com ticks itself.

### The working loop (after onboarding)

Skill `fibuki-belege`, "Mach meinen September fertig":

1. **Status:** progress widget for the period (Coverage, missing, waiting suggestions).
2. **Harvest:** suggestions FiBuKI already computed at Confidence >= 85 shown in the
   match-review widget, accepted in one batch. Never re-scored in the plugin.
3. **Hunt the gaps** in connected apps: Gmail / Outlook (Partner name, amount as
   `12,34` and `12.34`, date window -7..+30 days, "Rechnung", "Invoice", "Beleg"),
   then Drive / OneDrive / Dropbox. Recipe in `references/invoice-hunting.md`.
   Login-only portals (A1, Magenta, Wiener Netze, AWS): point to the FiBuKI browser
   extension (`/integrations/browser`), or in Codex use its browser to download.
4. **Upload** found documents; FiBuKI's pipeline extracts and suggests; accept in the widget.
5. **No-document lines:** bank fees, own transfers, taxes via No-document Categories,
   proposed as a batch, never silently.
6. **Close-out:** what is still missing, with Partner, amount, date.

UX rules: one confirmation per batch; Euro with comma for German users; reply in the
user's language with ADR-0007 vocabulary; never delete a Transaction (explain why);
on a plan-gate error (`fileUpload`, `aiMatching`) explain once and continue with what
is allowed.

### Widgets: yes, ChatGPT renders our own UI inline

ChatGPT apps can return a **widget**: an HTML bundle the MCP server serves as a
`ui://` resource, linked from a tool via `_meta` (MCP Apps: `_meta.ui.resourceUri`
with mime `text/html;profile=mcp-app`; the older ChatGPT form is
`openai/outputTemplate` with `text/html+skybridge`; support both if cheap). It renders
in a sandboxed iframe, inline in the chat, and can ask for **fullscreen** or
**picture-in-picture**. It gets the tool's `structuredContent`, can call our tools
itself, keep widget state, and post a follow-up message into the chat. Verify the
exact API names in Phase 0.

Three widgets, no more. Built with the FiBuKI design system tokens so it looks like FiBuKI:

| Widget | Shown by | Does |
|---|---|---|
| **Onboarding card** | `get_onboarding_status` | The checklist above. Each row: done tick, "do it here" (sends a follow-up message that starts the step in chat) or "open in FiBuKI" (deep link). |
| **Progress board** | `get_period_status` (see tools) | The pop-out moment. Per month of the accounting year: Coverage ring, counts (covered / missing / waiting). Fullscreen shows the missing list. Pinned in picture-in-picture while the agent hunts, so the user watches the numbers move. |
| **Match review** | after a harvest or upload | Rows: File thumbnail, Partner, amount, date, the Transaction, server Confidence. Per row accept / reject, plus "accept all >= 85". Calls `connect_file_to_transaction` / `dismiss_transaction_suggestion` directly, no model round trip. |

Widgets are presentation only: they show what tools return and call existing tools.

### Tools: what changes on the MCP surface

All existing 59 tools stay, same names, same handlers. Additions, all thin:

| Tool | Kind | Notes |
|---|---|---|
| `get_onboarding_status` | read | Ports the completion rules from `hooks/use-onboarding.ts` to the server (port, never regenerate; a shared test pins both to the same answers). Returns steps, done/skipped, deep links. Then the web hook reads this too, so parity is structural. |
| `complete_onboarding_step` / `skip_onboarding_step` | write | Callables replacing the direct client writes in `onboarding-ops.ts` (CLAUDE.md: all mutations through callables). |
| `create_identity_entity` | write | Today only `update_identity_entity` exists. Writes the same `userData` shape the settings page writes, so `onUserDataUpdate` does the rest. |
| `set_accounting_period` | write | Only if Decision 2 is "yes". |
| `get_period_status` | read | Counts per month for the progress board. Built from existing queries (`list_transactions_needing_files` logic), no new rules. If it needs new domain rules, stop and ask. |

Plus on every tool: `annotations` (`readOnlyHint` on reads, `destructiveHint` on
`delete_source`, `delete_file`, `merge_partners`, `cancel_invoice`), so ChatGPT asks for
confirmation on the right ones; `structuredContent` alongside the text block.

### How bytes move

| Surface | Source | Path |
|---|---|---|
| ChatGPT | file the user attaches | Apps SDK file params on `upload_file`: tool gets a short-lived download URL, passed to the (guarded) `url` fetch. |
| ChatGPT | Gmail / Drive via ChatGPT's apps | Spike. If no fetchable URL, the skill recommends FiBuKI's own Mail Integration instead, which is the stronger path anyway. |
| Codex | local file, CSV, browser download | `scripts/fibuki-upload.mjs <path...>` posts base64 with the API key. |
| Both | CSV | Amounts and dates are parsed by FiBuKI's own `lib/import` parsers (bundled into `scripts/csv-to-transactions.mjs` for Codex; for ChatGPT, Phase 4 decides between the model mapping rows or a server `import_csv` that reuses the same parsers). Never model arithmetic on money. |

## Plugin layout

```
integrations/openai-plugin/
  .codex-plugin/plugin.json   name, version, description, interface{displayName,
                              shortDescription, longDescription, category: "Finance",
                              capabilities, defaultPrompt[], brandColor, logo,
                              composerIcon, privacyPolicyURL, termsOfServiceURL,
                              websiteURL}, "skills", "mcpServers", "apps"
  .mcp.json                   {"mcpServers": {"fibuki": {"type": "http", "url": "https://fibuki.com/api/mcp/sse"}}}
  .app.json                   optional apps, ids copied from the examples repo:
                              gmail connector_2128aebfecb84f64a069897515042a44
                              outlook-email connector_4aaab2856305417b993eca9a216aaf6e
                              google_drive connector_5f3c8c41a1e54ad7a76272c89e2554fa
                              sharepoint connector_1e4f6a44acf14e3ca1d96672f8c945bc
                              dropbox asdk_app_69b31dc2110c8191b8b47dc98fe5a052
  skills/fibuki-onboarding/   steps 1-5, owns the onboarding card
  skills/fibuki-belege/       the working loop
  skills/fibuki-bank-csv/     CSV import, references/austrian-bank-csvs.md
                              (George, ELBA, Bank Austria, BAWAG, N26, Revolut, Wise:
                              encoding, delimiter, decimal comma, date format, columns)
  each skill: SKILL.md, agents/openai.yaml, references/, evaluations/*.json
  scripts/                    fibuki-upload.mjs, csv-to-transactions.mjs (Codex)
```

Widgets live server side (they are MCP resources), e.g. `functions/src/mcp-api/widgets/`,
built from a small React or plain-TS bundle into one HTML file each.

## Decisions Felix makes before Phase 3

1. **Signup from ChatGPT.** Invite-only blocks strangers. Options: (a) plugin-origin
   signups claim an open seat (`openSeats` exists already) and fall back to an access
   request with a friendly page; (b) open signup on the free plan for OAuth-origin
   users; (c) stay invite-only, the plugin is for existing users. Recommendation: (a).
2. **Accounting year as a concept.** Proposed: one setting per user, "the year we are
   preparing" (plus optional start date for a mid-year business start). It presets
   `syncFromYear`, drops older CSV rows, bounds mail search, and scopes the progress
   board. Needs a `CONTEXT.md` entry and probably an ADR (what happens at year end,
   can there be two open years in January?). Also lands in the web welcome flow.
3. **Mail source of truth.** Recommendation: FiBuKI's own Mail Integration primary
   (persistent, CASA-verified, background Sync); ChatGPT's apps only fill gaps inside a session.
4. **Track.** Plugin users always get `full_service`? Recommendation: yes.

## Phases (each one a separate small session)

### Phase 0: spike (half a day, no product code)
- Read the current Apps SDK / MCP Apps docs (widget `_meta` keys, display modes,
  file params, window bridge API, auth requirements: DCR vs client metadata documents).
- Point Codex at `https://fibuki.com/api/mcp/sse` with an `fk_` key; note what breaks.
- Find out what ChatGPT's Gmail and Drive apps return for an attachment.
- Output: outcome note appended here, with the verified API names.

### Phase 1: MCP server on the official SDK (plumbing, no behaviour change)
- Re-host the endpoint on `@modelcontextprotocol/sdk` Streamable HTTP, stateless mode,
  inside the existing `mcpSse` request function so the Next proxy and the self-host
  shim stay unchanged. Same `TOOL_DEFINITIONS`, same `handleToolInternal`, same API-key auth.
- Add `annotations`, `structuredContent`, `isError`.
- Contract test: same tool names and same `tools/call` results as before for a fixture user.
- SSRF guard on `upload_file` (https only, public IPs only after DNS resolve, size cap, timeout), with a test.

### Phase 2: Codex plugin, skills only
- `integrations/openai-plugin/` with the three skills, scripts, evaluations, README.
  Works against Phase 1 with an `fk_` key. Real use by Felix on his own last month;
  fix prompts, not the server.

### Phase 3: onboarding parity (after Decisions 2 and 4)
- `get_onboarding_status` (ported rules + shared test), step callables,
  `create_identity_entity`, `set_accounting_period`. Switch `hooks/use-onboarding.ts`
  and `onboarding-ops.ts` to them. Web welcome flow gains the accounting-year step.

### Phase 4: ChatGPT (after Decision 1)
- OAuth: Better Auth's OAuth provider / MCP plugin on fibuki-api, protected-resource
  metadata, consent page, tokens mapped to the same user + scopes as `validateApiKey`.
  Same feature on self-host.
- Signup policy from Decision 1 wired into the authorize page.
- Widgets (onboarding card, progress board, match review) + `get_period_status`.
- File params on `upload_file`.
- Submission: privacy policy, screenshots, review.

## Non-goals
- No scoring, matching, Category or VAT logic in the plugin or widgets (CLAUDE.md,
  "Server-Side Scoring Only").
- No exposing `lib/agent/tools/*` (Gmail search, convertEmailToPdf) over MCP.
- No outgoing invoices, no BMD export from the plugin, no Kanzlei flows.
- No more than three widgets.

## Guardrails for the implementing session
- Host safety from CLAUDE.md: no full vitest, no project-wide tsc, no `next build`.
- Branch from `main`, small commits, self-review the PR.
- Every write the skills make must be one the user confirmed in that turn's batch.
- If a step seems to need domain logic, stop and write it down here instead.
</content>
</invoke>
