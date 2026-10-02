# Workstream: FiBuKI as an OpenAI plugin (ChatGPT + Codex)

**Status (2026-10-02, v6):** Phases 1 (MCP server), 2 (plugin package + server-side dedupe),
3 (one onboarding, decided on the server) and the OAuth part of 4 are DONE on branch
`claude/sharp-meitner-w8f2qf`. Not yet run in a real Codex, ChatGPT or Claude session, and the web
changes of phases 3 and 4 were not clicked through in a browser (they are covered by component tests and
an end-to-end test with the official MCP SDK client). The `upload_file` SSRF guard is done (below). Next:
submission and real-client testing. The Chromium renderer is fixed (below) and the three widgets exist (below).

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
5. **Dedupe is server side, always.** No client (web hook, plugin script, skill) may carry
   its own duplicate check or hash formula; two copies drift.

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

## Phase 2 (DONE): plugin package + server-side dedupe

`integrations/openai-plugin/` (portable Agent Plugins layout, `plugin.json` and `mcp.json`
validated against the published schemas): skills `fibuki-onboarding`, `fibuki-belege`,
`fibuki-bank-csv` (each with `agents/openai.yaml` and evaluations, 9 in total), references for
invoice hunting and bank CSV layouts, and two scripts: `fibuki-csv.mjs` (generated bundle of
`lib/import` parsers + `src/csv-cli.ts`, rebuilt by `build.mjs`, staleness-checked by a test) and
`fibuki-upload.mjs`. Tests: `tests/openai-plugin-csv.test.mjs`, `tests/openai-plugin-upload.test.mjs`
(18, against fixtures and a fake API). README has the Codex install steps.

Found and fixed on the way:
- **`detectAmountFormat` read dot-decimal columns 100x too large.** `-89.99` parses under
  German rules too (as -8999), the first parser won the tie, so an N26 export would have been
  imported as -899900 cents. Ties are now broken by where the separators sit
  (`lib/import/amount-parsers.ts`). This affects the web import as well.
- **Dedupe moved to the server.** `functions/src/imports/dedupe.ts` owns the hash formula
  (pinned to the client function's output by a test) and "already imported by an earlier import".
  `import_transactions` (it never deduped before, and used another hash) and the web import's
  `bulkCreateTransactions` both use it, derive the hash themselves, and return `duplicateCount`.
  Identical lines of one file are kept, across chunks, via a shared `importJobId`.
  `hooks/use-import.ts` no longer hashes or checks. Rows imported through the API tool before
  this change carry the old hash and are not recognised.
- Default import ids are now unique (two calls in the same millisecond used to be "siblings").

**Still client-side (follow-up, same rule applies):** `lib/operations/banking-ops.ts`
(`checkDuplicatesBatch`, its own `generateDedupeHash`), `app/api/truelayer/{sync,accounts}/route.ts`,
`lib/truelayer/transform.ts`, `lib/operations/remap-ops.ts`, `hooks/use-investment-import.ts`
(all call `lib/import/deduplication.ts`), and `functions/src/finapi/syncCallable.ts` with
`banking/syncBankTransactions.ts` which have their own hash copies. Move each onto
`imports/dedupe.ts` (the hash formulas differ per provider today; check before unifying) and
delete `generateDedupeHash` / `checkDuplicatesBatch` from `lib/import/deduplication.ts` when none is left.

## Phase 3 (DONE): one onboarding, decided on the server

- **Track choice removed** (web and server): `welcome-choice.tsx`, `setOnboardingTrack`, `DATA_ONLY_STEPS`
  and the `test_integration` step are gone. Six steps for everyone. Accounts with the legacy
  `track: "data_only"` are retired on their next sync (marked complete and skipped, no celebration)
  instead of being reopened with six steps; `track: "full_service"` accounts carry on, and a present
  `track` counts as "has seen a welcome".
- **The rules moved to the server and are one copy.** `functions/src/onboarding/onboardingRules.ts`
  (pure, ported from the browser hook) and `onboardingState.ts` (facts, persistence, `toStatus`). A test
  pins the step list against the client's `types/onboarding.ts`. The browser hook now only listens to the
  document and calls `syncOnboarding` when the data its steps depend on changes; all writes are callables
  (`initOnboarding`, `syncOnboarding`, `updateOnboarding`). `lib/operations/onboarding-ops.ts` is deleted.
- **Trial** starts with the onboarding document (tier `smart`, for everyone), not with a track choice.
- **MCP tools** (62 now): `get_onboarding_status` (also records steps the data completed, accepts an
  optional `origin`), `skip_onboarding_step`, `create_identity_entity` (shares its normalisation with
  `update_identity_entity` instead of copying it). The plugin's onboarding skill uses them.
- **Origin** is recorded once when onboarding is created (`web`, `chatgpt`, `codex`, `claude`, `api`) and
  drives the welcome screen (`components/onboarding/welcome.tsx`, en + de): from an assistant "keep working
  there or continue here" with a back link (ChatGPT, Claude; Codex has no web page); otherwise a short start.
  The completion dialog and sidebar copy are translated too.
- A bug found on the way: completing an earlier step after a later one was skipped moved `currentStep`
  backwards. `currentStep` is now always the first open step.

Deliberate differences from the old browser rules (decide whether to change): the email step still counts
**Gmail only**, not IMAP (ported as is); the documents step reads `fileIds` / `noReceiptCategoryId` off the
first **500** transactions (equality queries only, so it needs no new Firestore index and runs on the
self-host shim); a user with more than 500 transactions and none of them matched in that window would not
advance, which does not happen once partner matching has run.

Follow-ups: (1) the web signup does not set `origin` yet. It must come from the OAuth client that started
signup (phase 4), not from the Referer header; until then web signups are `web` and tool-created ones `api`.
(2) `functions/src/selfhost/data-policy.ts` makes the whole `users/{uid}/settings` subtree client-writable,
so a browser could still write the onboarding document; it holds UX state only (the trial is in
`subscriptions`, server-only), but a per-document rule would be cleaner.

## Phase 4a (DONE): OAuth for connected apps

FiBuKI is the OAuth authorization server for its MCP endpoint; ChatGPT, Claude and Codex are public clients.

- **Server** `functions/src/oauth/`: authorization code + PKCE (S256 only), dynamic client registration
  (RFC 7591, public clients, https or loopback redirects only), refresh with rotation and reuse detection,
  discovery documents (RFC 8414 / 9728) built in one place, `iss` on authorization responses (RFC 9207).
  Collections `oauthClients` and `oauthCodes` (server-only in `data-policy.ts`, codes stored hashed).
  **Access tokens are API keys** (`fk_...`, 1 hour; refresh token 30 days, rotated), so `validateApiKey`, the MCP
  endpoint, expiry, revocation and the key list in Settings stay one mechanism: a connected app appears there
  as "ChatGPT (connected app)" and revoking it ends the grant. A code used twice revokes what it handed out.
- **MCP 401** now carries `resource_metadata="https://fibuki.com/.well-known/oauth-protected-resource/api/mcp/sse"`
  (`invalid_token` when a token was presented), which is how clients find the rest.
- **Public origin** is `FIBUKI_WEB_ORIGIN` (first non-`*` entry; fibuki.com in production), NOT `FIBUKI_PUBLIC_URL`
  (that is the API host). Self-hosters must set it to the address users reach the web app at; it is the issuer
  and the base of the MCP resource URL. Helper is `webOrigin()` (named to avoid `utils/publicOrigin.ts`).
- **Web** (Next, on the public origin): `/.well-known/oauth-authorization-server`,
  `/.well-known/oauth-protected-resource/[[...path]]`, `/api/oauth/{register,token,client}` are thin proxies
  (`lib/api/oauth-proxy.ts`); `/oauth/authorize` is the page.
- **The authorize page works for every visitor** (`lib/oauth/authorize-step.ts` decides, tested as a matrix):
  signed out -> sign in or create an account, back to the same request, `login_hint` prefilled on sign-in;
  signed in as the suggested account (or no hint) -> consent; signed in as another account -> asks which, never
  silently picks (and can sign out and return with the suggested email); a second factor still pending counts as
  signed out; a user FiBuKI does not know yet is asked who they are before consent (name, UID, IBAN); an
  unusable request is explained and never offers consent; a callback on a host that is not chatgpt.com /
  claude.ai / claude.com is shown with a warning, because registration is open.
- **Origin** of a user who signs up through an app is recorded from the registered client's callback host when they
  consent (only by the call that creates the onboarding record); loopback apps are `api` (Codex and Claude
  Code look alike). Never from the Referer.
- `/login` honours `?email=`; `/login` and `/register` now accept only a same-site `?redirect`
  (`lib/auth/safe-redirect.ts`; the old `startsWith("/")` check let `//host` through) and `/register` honours it.
- Integration pages (ChatGPT, Claude) lead with the one-click steps; the plugin README connects Codex with
  `codex mcp login fibuki`. The plugin scripts still need an API key (they call FiBuKI directly).

Verified: 49 server tests, 15 + 14 + 6 component tests, and `oauthSdkInterop.test.ts`, which runs the official
MCP SDK OAuth client through discovery, registration, the authorize URL, code exchange, a tool call as the
consenting user, and a refresh after the access token expired. `next build` passes with the new routes.

Not done / follow-ups:
1. **Real clients.** Try ChatGPT developer mode and Claude custom connector against a deployed build.
   ChatGPT may send `login_hint` / `target_flow`; both are handled (hint) or ignored (flow).
2. **Open registration grows `oauthClients` forever, and unused `oauthCodes` expire but are never deleted.**
   Add a scheduled cleanup (clients never used for a token after N days, codes past expiry).
3. **No client ID Metadata Documents (CIMD)**; not advertised, DCR is. Add if a client needs it.
4. **No profile tool** (`_meta["openai/profile"]`, multi-account). Optional.
5. Users whose signup is blocked by the invite gate never reach consent (they get the access-request flow).
   The signup-policy decision (open seat for app-origin signups) is still open.
6. `oauthToken` / `oauthRegister` rate limiting is only the host's general per-IP limiter.
7. Docs: `deploy/selfhost/README-hetzner.md` should say `FIBUKI_WEB_ORIGIN` is now also the OAuth issuer.

## SSRF (DONE: fetches and the PDF renderer)

`functions/src/utils/safeFetch.ts` is the one way to fetch a URL a user supplied: https only, port 443, no
credentials; the host must resolve ONLY to public addresses, checked inside the connection's own DNS lookup (the
address checked is the address connected to, so a rebinding host cannot answer differently); IP literals
(any spelling the URL parser normalises, plus IPv4-mapped / NAT64 / 6to4 IPv6) checked directly; trailing-dot and
single-label names (compose services such as `fibuki-api`, `postgres`, `seaweedfs`) refused; every redirect
re-checked; 25 MB, 30 s and 3-redirect caps, with an absolute deadline so a slow-drip server cannot hold a request.
136 tests, including the real socket and resolver.

Used by: `upload_file` with a `url` (the hole flagged since phase 1: on the Hetzner box it could reach
fibuki-api, Postgres and SeaweedFS), and the `lookupCompany` callable, which fetched
`https://<whatever the user typed before the first "/">/impressum` with a plain `fetch` (found while checking
for the same pattern). Everything else that calls `fetch` uses fixed hosts (Google, Stripe, FinAPI, ...).

**Fixed: `convertHtmlToPdf` (functions/src/precision-search/htmlToPdf.ts, guard in `renderGuard.ts`).** It
rendered caller-supplied HTML in Chromium with script on and no network limits (callers: the callable, inbound
email from anyone, precision search, the UVA PDF). Reproduced first in a real Chromium against a loopback
"internal service": an iframe, image, stylesheet, CSS background, @import, object, meta refresh, form post and
script fetch/Image all reached it. Now the page has script off and request interception on: only image,
stylesheet and font requests are served, everything else (documents/iframes/navigations, fetch, websocket,
media, POST, file:, cid:, plain http) is aborted. A remote https subresource is fetched BY US through
`fetchPublicUrl` and handed to the browser with `respond()`, so Chromium never opens a connection and DNS
rebinding has nothing to rebind (the earlier "partly open" caveat is gone). Caps: 40 subresources, 5 MB each,
15 MB total, 8 s each. `<meta http-equiv=refresh>` is stripped first, otherwise the refused navigation replaces
the page with an error page. Cost: plain-http images no longer load (https only), and no script runs.
Tests: `htmlToPdf.integration.test.ts` (10 attacks, real Chromium, skipped when none is installed; set
`FIBUKI_CHROME_PATH`) and `renderGuard.test.ts` (unit).

Also: `docs/casa/05-tier2-checklist.md` row 12.6 says "SSRF protection: MET - all outbound HTTP uses fixed
hostnames; no user-controlled URL fetch". That was not true before this change (it is true now). Proposed edit, for a human to make: restate it as met by `safeFetch.ts` (user URLs) and
`renderGuard.ts` (the PDF renderer).

## Sign in with ChatGPT / Claude (checked 2026-10-02, optional, not needed for phase 4)

Two different things get called "OAuth with these services". The connect flow needs the first;
the second is a convenience.

1. **FiBuKI as the OAuth server (required).** ChatGPT and Claude are OAuth clients of FiBuKI.
   The user signs in to FiBuKI the way they do today (Google or email), then consents. Phase 4 builds this.
2. **ChatGPT or Claude as the identity provider ("Continue with ChatGPT").**
   - OpenAI has **Sign in with ChatGPT** (OIDC, scopes `openid profile email`, stable account id, no access to
     conversations): https://developers.openai.com/siwc/quickstart.md . **Limited trial for selected commercial
     partners; waitlist** via https://openai.com/form/sign-in-with-chatgpt-interest/ . It has a plugin variant
     (`/siwc/chatgpt-plugin.md`): ChatGPT's connect modal shows "Continue with ChatGPT", and ChatGPT calls our
     `/oauth/authorize` with `target_flow=chatgpt_siwc` and `login_hint=<email>`. Our authorize page then runs a
     second, inner OIDC flow against OpenAI, verifies the ID token and issues its own connector code. Two
     independent OAuth transactions; keep state, PKCE and codes separate.
   - Anthropic: no equivalent "Sign in with Claude" for third-party apps found in the docs index
     (docs.claude.com/llms.txt). Claude's connector flow is the same remote-MCP OAuth with FiBuKI as server.

Consequence for phase 4: build (1) so that it already accepts `login_hint` (prefill / account chooser) and
ignores `target_flow` it does not know. Add "Continue with ChatGPT" only if OpenAI admits FiBuKI to the trial;
it would also give a verified email, which helps the signup-policy decision (invite-only vs open seat).

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
- **Phase 2: plugin package, skills only.** DONE (above). Still to do by hand: run it in
  Codex (first check: the bundled `mcp.json` server against a `config.toml` entry), run the
  evaluations, test with MCP Inspector, add real anonymised bank exports to
  `tests/fixtures/openai-plugin`.
- **Phase 3: onboarding simplification (web, useful without the plugin).** DONE (above). Original scope:
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
  - **SSRF guard on `upload_file`** DONE, see the SSRF section (was: unrestricted `fetch(url)` at
    `functions/src/tools/handlers.ts:2864`; on Hetzner it reaches fibuki-api, Postgres,
    SeaweedFS). https only, public IPs after DNS resolve, size cap, timeout. Do this
    before anything sends it third-party URLs; it is a real finding today.
  - Widgets + `get_period_status` + `list_pending_matches` + file params: DONE (see "Widgets as built").
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


## Widgets as built (phase 4)

- `functions/src/mcp-api/widgets.ts`: three self-contained HTML documents served as `ui://fibuki/{onboarding,progress,review}.html`
  (mime `text/html;profile=mcp-app`), via MCP `resources/list` / `resources/read` (server now advertises `resources`).
  Tools carry `_meta.ui.resourceUri` (+ `openai/outputTemplate`): `get_onboarding_status` -> onboarding card,
  `get_period_status` -> progress board, `list_pending_matches` -> match review. `upload_file` carries
  `openai/fileParams: ["file"]`.
- New read-only tools (`functions/src/tools/periodStatus.ts`): `get_period_status` (per-month covered / missing /
  parked, newest 25 missing lines, waiting-suggestion count; "missing" is exactly the `list_transactions_needing_files`
  rule, tested against it) and `list_pending_matches` (files with no connection whose best suggestion clears the bar,
  using the suggestion's stored preview, so no extra reads). Nothing is scored.
- `upload_file` accepts `file: {download_url, file_id}` (a chat attachment); it takes the same guarded download as `url`.
- Widgets only call existing tools: `connect_file_to_transaction`, `dismiss_transaction_suggestion`,
  `auto_connect_file_suggestions`, `upload_file`. Server text is rendered with textContent only (tested).
  The bridge speaks MCP Apps JSON-RPC over postMessage and falls back to `window.openai`; the drop zone shows only where
  `window.openai.selectFiles/uploadFile/getFileDownloadUrl` exist.
- Tests: `functions/src/tools/__tests__/periodStatus.test.ts`, `mcp-server.test.ts` (resources, tool meta),
  `tests-components/plugin-widgets.test.tsx` (real widget pages in jsdom with a fake host).
- NOT verified: the MCP Apps handshake details (`ui/initialize` params, `ui/message`, `ui/open-link`, `window.openai`
  method names and shapes) were written from the spec as read on 2026-10-02 and tested only against a fake host. The
  first real ChatGPT / Claude session decides; expect small fixes to `BRIDGE` in widgets.ts. File thumbnails in the
  review were left out (file name only) to avoid a download-URL surface in the widget.
- Not done: widget CSP declaration in the resource `_meta` (widgets load nothing external, so the host default
  applies), the `openai/profile` tool, submission.
