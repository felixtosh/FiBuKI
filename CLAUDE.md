# Claude Code Instructions

## Project Overview
FiBuKI - A tax/accounting tool for managing bank transactions, receipts, and categorization.

**Read these before proposing features, schema changes, or roadmap items:**

- **[`docs/who-is-this-for.md`](docs/who-is-this-for.md)** — who FiBuKI is for and what
  it is not. FiBuKI is **pre-accounting for Austrian one-person businesses (EPUs)**.
  Austria only. The Tax Advisor (Steuerberater) is a gatekeeper, not a buyer — we do not build a
  practice-management product. Self-host and cloud ship the **same features**; the
  split is effort and infrastructure, never capability. Check proposals against this
  page first.
- **[`docs/rewrite-goals.md`](docs/rewrite-goals.md)** — the Firebase → Postgres
  rebuild: goals, stack, phases, and constraints. Core rules: **port, never
  regenerate domain logic**; **self-host is multi-tenant with one tenant**; **we own
  the API layer** (the client never touches the DB). Tests come before any port work.
- **[`docs/claude-practices.md`](docs/claude-practices.md)** — how to drive this repo:
  host safety, bounded output, model routing, small sessions + handoffs, spec→`/goal`.

## Agent skills

This repo is configured for the [mattpocock/skills](https://github.com/mattpocock/skills)
engineering skills (`/wayfinder`, `/domain-modeling`, `/triage`, `/to-tickets`,
`/grill-with-docs`, `/code-review`, ...).

### Issue tracker

GitHub issues on **`felixtosh/FiBuKI`** — the one trunk. Writing there needs the classic
token, not the box's default fine-grained one, and every `gh` call needs an explicit `-R`.
See [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).

### Triage labels

The five canonical roles, each label string equal to its name. See
[`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).

### Domain docs

Single-context: [`CONTEXT.md`](CONTEXT.md) at the root plus [`docs/adr/`](docs/adr/).
Read them before exploring, and use the glossary's terms in issues, tests and proposals.
See [`docs/agents/domain.md`](docs/agents/domain.md).

## Host safety (enforced)

**Never run a full `vitest`, a project-wide `tsc`, or `next build` on a small host.**
Each spawns per-CPU workers with their own V8 heaps and OOM-freezes a 4 GiB box hard
enough to need a reset. `.claude/hooks/guard-memory.sh` blocks these shapes via a
`PreToolUse` hook when `MemTotal <= 8 GiB` or `MemAvailable < 4 GiB`; on a normal
workstation it never fires. Use the scoped forms instead:

```bash
npx vitest run <one-file> --pool=forks --maxWorkers=1
# tsc: a throwaway config inherits the project's options; the heap cap is a
# Node flag (tsc rejects --max-old-space-size as an argument)
echo '{"extends":"./tsconfig.json","include":[],"files":["src/foo.ts"]}' > functions/tsconfig.scoped.json
NODE_OPTIONS=--max-old-space-size=900 npx tsc --noEmit -p functions/tsconfig.scoped.json
```

Full suites belong on CT 999. Also: **no parallel sub-agents on the audit box** —
fan-out is what OOMs it. Details in [`docs/claude-practices.md`](docs/claude-practices.md).

## Self-host realities (read before debugging)

Things that cost real time to find. All of `fibuki.com` runs the self-host stack.

- **Node 22, not 20.** `package.json` says `22.x`. On Node 20, npm silently
  skips optional deps that need 22 (`@google-cloud/firestore` and ~70 others)
  and tests fail far from the cause. `node -v` first.
- **Local dev = the self-host stack, not Firebase emulators.** API:
  `cd functions && npm run selfhost:api` (port 8788); web: `npm run dev -- -p 3000`
  (not bare `next dev`: `predev` copies pdf.js's wasm decoders, without which
  JPEG 2000 scans draw blank) with `FIBUKI_BACKEND=selfhost`, `NEXT_PUBLIC_FIBUKI_API_URL=http://localhost:8788`
  and `NEXT_PUBLIC_FUNCTIONS_URL=http://localhost:8788` (server-side callables, e.g.
  the chat's tools; without it they fall back to a dead Firebase emulator).
  Dev login: `FIBUKI_DEV_UID` (API) plus `NEXT_PUBLIC_FIBUKI_DEV_UID` /
  `NEXT_PUBLIC_FIBUKI_DEV_EMAIL` (web). AI keys and `GOOGLE_CLOUD_PROJECT` go in
  `functions/.env.local` (gitignored); without them CSV import's AI column
  matching fails. The API loads code at start: restart it after a pull.
- **One tenant, many users.** `getTenantId()` is per deployment, so every
  fibuki.com user shares a tenant and RLS does not separate them; only the
  app's ownership checks do. The client access policy is
  `functions/src/selfhost/data-policy.ts` (not `firestore.rules`). The browser
  reads domain data and never writes it ([ADR-0016](docs/adr/0016-the-browser-reads-the-server-writes.md)):
  a new write is a callable, and `functions/src/selfhost/browser-writes.test.ts`
  fails on a new client SDK write in browser code or a server route. Never take a
  uid from a body, query, header or cookie. A new Next API route checks
  ownership of every id it is given and gets a case in
  `functions/src/selfhost/security/cross-user-routes.test.ts`; callables, AI
  tools and data-plane routes are attacked generically by that folder already.
- **List-page URL state:** change the query with `pushQuery` / `replaceQuery`
  (`lib/navigation/query-url.ts`), never `router.push`: a soft navigation is an
  RSC round trip (~600ms on fibuki.com) before the selection even renders.
- **Dates:** stored dates are UTC midnight of the Vienna calendar day. Read the
  day from the UTC date part (`toISOString().slice(0, 10)`), never
  `getDate()` / `getFullYear()` / `setDate()`: those depend on the host's zone.
- **`runTransaction` is optimistic, like Firestore:** the callback can run more
  than once, so no side effects inside it, and all reads before any write.
- **Deploys:** a newer push cancels a pending deploy run. "cancelled" is normal;
  watch the latest run for the commit you care about.

## Architecture: Cloud Functions Pattern

**IMPORTANT**: All data mutations go through Cloud Functions. This ensures:
- Single source of truth for business logic
- Consistent access from UI, MCP, LangGraph, and external actors
- Automatic usage tracking for admin/user dashboards and billing

### The Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│                     CONSUMERS                                   │
│  React UI  │  MCP Server  │  LangGraph  │  External Actors      │
└─────────────────────────────────────────────────────────────────┘
                              │
                    httpsCallable / HTTP
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  CLOUD FUNCTIONS (europe-west1)                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  createCallable() wrapper                               │   │
│  │  - Auth validation                                      │   │
│  │  - Usage logging (function invocations)                 │   │
│  │  - AI usage logging (model calls)                       │   │
│  │  - Error handling                                       │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│                     Individual Callables                        │
│  transactions/ │ files/ │ partners/ │ sources/ │ imports/      │
└─────────────────────────────────────────────────────────────────┘
                              │
                        Admin SDK
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        FIRESTORE                                │
│  transactions │ files │ partners │ sources │ aiUsage │ fnCalls │
└─────────────────────────────────────────────────────────────────┘
```

### Rules for New Features

1. **All mutations go through Cloud Functions**
   - ❌ Direct Firestore writes in hooks/components
   - ✅ Call Cloud Functions via `callFunction()` from `lib/firebase/callable.ts`

2. **Create callable functions using the `createCallable()` wrapper**
   - Located in `/functions/src/utils/createCallable.ts`
   - Automatically handles auth, usage tracking, and error handling

3. **Realtime listeners stay in hooks** (this is OK)
   - Use `onSnapshot` for realtime updates in React hooks
   - Only mutations need to go through Cloud Functions

4. **When adding a new feature:**
   ```
   1. Add types to /types/new-entity.ts
   2. Create callable in /functions/src/feature/newFeatureCallable.ts
   3. Use createCallable() wrapper for automatic usage tracking
   4. Register its config.name in /functions/src/callableRegistry.ts and export it
      from /functions/src/index.ts under that name (the host serves the export name)
   5. Call from frontend via callFunction() in /lib/firebase/callable.ts
   ```

### Example: Adding a new callable

```typescript
// /functions/src/categories/createCategory.ts
import { createCallable, HttpsError } from "../utils/createCallable";

interface CreateCategoryRequest {
  name: string;
  color: string;
}

interface CreateCategoryResponse {
  success: boolean;
  categoryId: string;
}

export const createCategoryCallable = createCallable<
  CreateCategoryRequest,
  CreateCategoryResponse
>(
  { name: "createCategory" },
  async (ctx, request) => {
    const { name, color } = request;

    if (!name) {
      throw new HttpsError("invalid-argument", "name is required");
    }

    const docRef = ctx.db.collection("categories").doc();
    await docRef.set({
      userId: ctx.userId,
      name,
      color,
      createdAt: FieldValue.serverTimestamp(),
    });

    return { success: true, categoryId: docRef.id };
  }
);
```

```typescript
// /hooks/use-categories.ts
import { callFunction } from "@/lib/firebase/callable";

export function useCategories() {
  // Realtime listener stays in hook
  useEffect(() => { onSnapshot(...) }, [userId]);

  // Mutations call Cloud Function
  const addCategory = useCallback(async (data) => {
    return callFunction("createCategory", data);
  }, []);
}
```

### Available Callables

**Transactions:**
- `updateTransactionCallable` - Write what a foreign or 0% line is for the UVA (`foreignSupplyKind`, `saleSupplyKind`); refuses any other field (#621)
- `bulkUpdateTransactionsCallable` - Write description, completion, Partner or no-receipt category onto many transactions; refuses any other field, and a Partner or category the caller may not use (#621)
- `deleteTransactionsBySourceCallable` - Delete all transactions for a source
- `acceptReceiptOnlyCallable` - Record or revoke an Accepted Receipt ruling on a receipt-only transaction (#165)
- `acceptPartialPaymentCallable` - Record or revoke an Accepted Partial Payment ruling on a tipped transaction the bank line does not cover (#554)
- `rollbackTransactionCallable` - Restore the values one history entry says an edit replaced, through `update_transaction`'s rules (only the fields an edit writes; #616)

**AI tools:**
- `runToolCallable` (`runTool`) - Run one tool from `functions/src/tools/definitions.ts` as the session's User, through the handler MCP uses (#616)

**Files:**
- `connectFileToTransactionCallable` - Connect file to transaction. Takes the Connection Origin (`manual`, `suggestion`, `agent`, `auto`); an accepted suggestion sends no score, the server reads the stored one
- `disconnectFileFromTransactionCallable` - Disconnect file from transaction
- `refreshTransactionMatchesCallable` - Run the matcher on one File ("refresh matches"); it auto-connects under the upload trigger's rules

**File Connections have one writer** (`functions/src/fileConnections/`, #612): connect,
Unlink and the bulk removals (deleting a File, deleting Transactions with their bank
account or import, the Copy swap) all go through it, and no other code writes a
`fileConnections` record, a File's `transactionIds` or a Transaction's `fileIds`. Its
rules key on the Connection Origin (`rules.ts`). A guard test fails on a new writer; a
Next API route connects through the callable as the user (`lib/api/connect-file.ts`).
- `updateFileCallable` - Update file metadata
- `deleteFileCallable` - Delete a file: hides it, undone by `restoreFile`, never touches the stored bytes. Refuses a FiBuKI-generated invoice document (ADR-0006)
- `purgeFilesCallable` - Purge deleted files: destroys the stored bytes (verified) and reduces the record to dedup keys. Deleted-files view only; never on the MCP/tool surface
- `splitFileCallable` / `dismissSplitSuggestionCallable` - Split a PDF holding several invoices or Receipts into one File per range (parts take over the File Connections, the original is deleted and cannot be restored while a part lives), and "not a bundle" for the Extraction's split suggestion (#550)
- `markFileAsCopyCallable` / `unmarkFileAsCopyCallable` / `makeFileTheOriginalCallable` - Mark a File as a Copy of another, "Not a Copy" (undo or decline, stores a standing ruling), and swap a Copy with its original (#162, ADR-0010). A Copy holds no File Connection

**Invoice Corrections (#564, ADR-0010):**
- `linkCorrectionCallable` / `unlinkCorrectionCallable` - Link a correction File to the File it corrects (also accepts a suggestion), or unlink / decline one; a declined pair is never linked automatically again
- `getCorrectionCallable` - What a File corrects and who paid the original, or a Transaction's related refund or purchase
- `backfillCorrectionLinksCallable` - Run the correction check over the user's existing Files once

**Receipt Links (#571, ADR-0012):**
- `linkReceiptCallable` / `unlinkReceiptCallable` - Link a Receipt to the invoice it pays (also accepts a suggestion), or unlink / decline a pair; a declined pair is never linked or suggested automatically again. Connecting either File of a linked pair connects the other (`auto`, reason `paired`)
- `getReceiptLinkCallable` - A File's invoice or Receipts, and its pairing suggestions
- `backfillReceiptPairsCallable` - Run the suggestion side of the pair check over the user's stored Files once; records no link

**UVA filing:**
- `markUvaPeriodFiledCallable` - Record what was filed for a period (append-only, editable figures); refused while the period has blockers
- `getUvaFiledStatusCallable` - Blockers, filed vs now per Kennzahl, and earlier filed periods whose figures moved

**Imports:**
- `bulkCreateTransactionsCallable` - Bulk create transactions from CSV
- `createImportRecordCallable` - Create import record

### Usage Tracking

All callable functions automatically log to `functionCalls` collection:
- Function name
- User ID
- Duration (ms)
- Status (success/error)
- Timestamp

AI usage is logged separately to `aiUsage` collection via `ctx.logAIUsage()`

### Server-Side Tool Registry (MCP/API)

External AI integrations (OpenClaw, Claude Desktop, ChatGPT) and the chat assistant use
one shared tool registry:

```
┌──────────────────────────────────────────────┐  ┌──────────────────────────┐
│               EXTERNAL AI TOOLS              │  │  Chat assistant          │
│  OpenClaw │ Claude Desktop (MCP) │ ChatGPT   │  │  (lib/agent/tools/)      │
└──────────────────────────────────────────────┘  └──────────────────────────┘
                       │                                       │
             HTTP + API key auth                  runTool callable, session auth
                       │                                       │
                       └───────────────────┬───────────────────┘
                                           ▼
┌─────────────────────────────────────────────────────────────────┐
│              functions/src/tools/handlers.ts                    │
│              (Single source of truth)                           │
│  listSources │ listTransactions │ connectFile │ ...             │
└─────────────────────────────────────────────────────────────────┘
```

**Key files:**
- `functions/src/tools/handlers.ts` - All tool implementations
- `functions/src/mcp-api/index.ts` - REST API endpoint (mcpApi)
- `functions/src/mcp-api/mcp-sse.ts` - MCP protocol endpoint (mcpSse)
- `functions/src/tools/runToolCallable.ts` - the same tools with the User's login session (#616)
- `app/api/openapi.json/route.ts` - the one OpenAPI spec, derived from the definitions

**A new tool is its definition and its handler.** The definition in
`functions/src/tools/definitions.ts` carries its annotation class (`annotation`:
read-only / write / destructive, required by the type), its case goes in `handlers.ts`,
and `lib/data/generated-tool-definitions.ts` is regenerated
(`npm run generate:tool-definitions`; CI's drift check runs only after the unit tests
pass). The OpenAPI spec, llm.txt and the chat's wrappers all read that file. The generator reads the compiled
`functions/lib`; on a small host compile `src/tools/definitions.ts` alone instead of
the whole project, into `functions/lib` with `src` as the root (a narrower root writes
stray `.js` files into `src/`, and an old `functions/lib/tools/definitions.js` is read
silently, so check the new tool's name is in the regenerated file):

```bash
cd functions && rm -rf lib/tools && NODE_OPTIONS=--max-old-space-size=900 npx tsc --ignoreConfig \
  src/tools/definitions.ts --outDir lib --rootDir src --module commonjs --target es2020 --skipLibCheck
cd .. && npm run generate:tool-definitions
```

**The chat assistant runs these tools, it does not reimplement them (#616).** A chat tool
with an MCP twin is a thin wrapper in `lib/agent/tools/mcp-tools.ts` over the `runTool`
callable, which runs the named tool through `handleTool` as the session's User, with the
plan feature gate and without the API-key rate limit. The MCP output shape is the contract
external integrations depend on: a wrapper passes it through, reformatted for reading
only (`forTheModel`: Timestamps as ISO strings; a File's OCR text and a Transaction's
import and automation bookkeeping left out of list rows, the single get keeps them), and
filtering or computing lives only in the shared tool. Chat-only tools (queue status,
Transaction history, navigation, Gmail search, the Partner batch context) keep their own
reads. Every amount the chat reads is integer cents, the chat-only tools' included.
`functions/src/selfhost/chat-mcp-tools.test.ts` holds each wrapper to its twin's output
and fails if one reads or writes the database itself.

**Who called is the server's to say (#665).** `handleTool` takes a caller
(`functions/src/tools/caller.ts`): MCP and the REST API by default, the chat agent when
`runTool` calls it, with the worker type the worker runtime sends beside the arguments.
A handler that records who made a write (a Partner assignment's `ai` / `api`, a File
Connection's origin `agent` / `mcp`) or applies the agent's connect checks reads that
parameter, never an argument. A User reaching `runTool` gets nothing the existing
callables do not already allow.

## Business Rules

### Server-Side Scoring Only

**CRITICAL**: All file/transaction matching and scoring MUST use server-side Cloud Functions. Never implement local scoring logic in frontend hooks or components.

**Why**: Ensures consistency between UI and AI/agent tools. Both must produce identical scores.

**Scoring Architecture**:
```
┌─────────────┐     ┌─────────────┐     ┌─────────────────────────────┐
│  Frontend   │────▶│  API Route  │────▶│  scoreAttachmentMatchCallable│
│  (hooks)    │     │             │     │  (Cloud Function)           │
└─────────────┘     └─────────────┘     └─────────────────────────────┘
                                                      ▲
┌─────────────┐                                       │
│ Agent Tools │───────────────────────────────────────┘
│  (search)   │     (calls directly via callFirebaseFunction)
└─────────────┘
```

**Rules**:
1. **One matcher (#613)**: `functions/src/matching/matcher.ts` owns which File/Transaction pairs are possible (the eligibility rule and the date window), the scoring inputs, and the call into the scoring core, in both directions. Every surface calls it: the upload trigger, both connect windows, find-receipt, the agent's tools, MCP, Partner matching and both re-scores. A new surface calls it too; `scoringInputs-guard.test.ts` fails on a second caller of the core, a hand-built input or a date window
2. **Frontend scoring**: a stored File against a Transaction goes through the matcher's own callables, `findTransactionMatchesForFile` (File side) and `findFileMatchesForTransaction` (Transaction side, #555). Mail results that are not Files yet go through `/api/matching/score-files`, which proxies to `scoreAttachmentMatchCallable`
3. **Agent tools**: Score a File/Transaction pair by id with the `scoreFileTransactionMatch` callable via `callFirebaseFunction`; it also says whether the matcher could propose the pair (`ineligible`, `hidden`). The agent's local search ranks stored Files with `findFileMatchesForTransaction`, and the `findReceiptForTransaction` workflow with the same matcher, auto-connecting only at its threshold; Gmail results keep the attachment scorer, for ranking only (#588)
4. **Pre-computed scores**: Stored in `file.transactionSuggestions` (computed by `matchFileTransactions` trigger)
5. **NEVER** implement local `scoreResult()` or similar functions in hooks/components

**Key Files**:
- `functions/src/matching/matcher.ts` - The one matcher for stored Files: eligibility, date window, inputs, scoring
- `functions/src/precision-search/scoreAttachmentMatch.ts` - Scoring for mail results that are not Files yet
- `functions/src/precision-search/scoreAttachmentMatchCallable.ts` - Callable wrapper
- `app/api/matching/score-files/route.ts` - API route for frontend
- `functions/src/matching/matchFileTransactions.ts` - Pre-computes suggestions on file upload
- `lib/partners/partner-suggestions.ts` - Which stored Partner suggestions a surface shows (list cell and detail panel use the same one; it filters, it never scores)

**Claude Code Hook**: `.claude/hooks/check-cloud-function-pattern.sh` warns if local scoring is detected.

### Transaction Deletion NOT Allowed

**CRITICAL**: Individual transactions cannot be deleted through the UI or MCP.

**Reason**: Transactions are tied to bank account imports. If a bank CSV doesn't include all transactions, deleting individual ones would create accounting inconsistencies.

**Correct behavior**:
- Transactions can only be deleted when their entire source (bank account) is deleted
- Use `deleteTransactionsBySource()` in operations layer
- The `deleteTransaction` and `bulkDeleteTransactions` functions are NOT exposed

**If someone asks to delete a transaction**: Explain that this would break accounting integrity. They should either:
1. Delete and re-import the entire bank account
2. Mark the transaction with a note/category instead

## Test Data

### Test Data Files
- `/lib/test-data/generate-test-transactions.ts` - Generates test source + 100 transactions

The Bank Accounts page no longer has a test data toggle; its browser writer was
deleted with the other dead writers (#625).

### Updating Test Data
When modifying transaction-related types, also update the test data generator:

**Files that require test data updates when changed:**
- `types/transaction.ts` - Transaction interface
- `types/source.ts` - TransactionSource interface
- `lib/import/field-definitions.ts` - Import field definitions

**Test data includes:**
- 85 realistic transactions (expenses: REWE, Amazon, Netflix, etc. / income: salary, freelance)
- 15 edge cases (large amounts, special characters, missing fields, duplicates)

## UI Text (#168)

The UI is bilingual (German and English) through next-intl. **New UI text goes into
`messages/en.json` and `messages/de.json`**, read with `useTranslations` /
`getTranslations`, never as a literal in JSX. `npm run lint:strings` (in CI) fails when a
`.tsx` file under `app/(dashboard)` or `components` gains a hardcoded string; after
translating a screen, run `node scripts/check-ui-strings.mjs --update` to shrink its
allowance. English is the fallback for a missing German key and for any browser language
other than German. Vocabulary follows ADR-0007.

`lint:strings` is a regex, not a parser: anything between a `>` and the next `<` that
holds letters and no braces counts as text. So an arrow (`=>`), a generic
(`Set<string>`) or a chained JSX ternary (`) : other ? (`) between two JSX blocks reads
as a hardcoded string. Don't raise the allowance for these; reshape the code instead:
a type alias (`type IdSet = Set<string>`), `{cond ? (<A />) : null}` blocks instead of
chained ternaries, counts or helpers moved below the component.

## List pages (Files, Transactions, Partners)

The lists share one pattern (noted where one differs); a new list reuses it rather
than reinventing it.

- **Filters: one per column, named like the column.** `ChoiceFilter` (single choice),
  `PartnerFilter` (search, "No partner assigned", the partners) and `DateRangeFilter`,
  laid out by `OverflowFilterRow`: what doesn't fit goes behind "More", and More lists
  every filter. A chip can be on screen twice (row and panel), so every chip owns its
  popover state; never keep a chip's open state in the toolbar.
- **Selection (Files, Partners): `lib/selection/bulk-file-selection.js`.** A plain
  click browses (opens the detail panel, box stays empty); checkboxes and
  cmd/shift-click build a bulk selection. One ticked item still shows its detail panel; from two, the sidebar shows
  the list's bulk panel with the actions in its footer. The checkbox column is
  `SELECT_COLUMN_WIDTH`. Pass the selection to the table (`enableMultiSelect` +
  `selectedRowIds`) and route row handlers through `useLatestCallback`, or the
  memoised rows keep stale state (#232).
- **Counter: `ProgressCounter`** (ring, done / total, explanation popover on hover).
- **Remembered filters: `useRememberedListQuery`** (Files, Partners; Transactions keeps
  its own in `lib/filters/url-params.ts`), per browser, never server-side, so two
  screens don't overwrite each other's view (#530).

## Key Directories
- `/app/(dashboard)/` - Main app pages (sources, transactions)
- `/components/` - React components
- `/hooks/` - Custom React hooks
- `/lib/` - Utilities and business logic
- `/types/` - TypeScript interfaces

## Chrome Extension Release Guardrails

For any change affecting the browser extension or its publish workflow, follow:
- `/extensions/taxstudio-browser/RELEASING.md`

Non-negotiable checks before a GitHub release:
- Bump `/extensions/taxstudio-browser/manifest.json` `version` (must increase each upload)
- Keep workflow target path as `/extensions/taxstudio-browser`
- Do not rename required GitHub secrets:
  - `CWS_SERVICE_ACCOUNT_EMAIL`
  - `CWS_SERVICE_ACCOUNT_KEY`
  - `CWS_PUBLISHER_ID`
  - `CWS_EXTENSION_ID`

Release trigger:
- Publishing a GitHub Release runs `.github/workflows/chrome-web-store-release.yml`

## Data Storage
- Firebase Firestore for data persistence
- Collections: `sources`, `transactions`, `receipts`, `files`, `partners`, `emailIntegrations`
- User authentication via Firebase Auth (email/password + Google Sign-In)
- User ID obtained from `useAuth()` hook in client components or `getServerUserIdWithFallback()` in API routes

## AI Models

### Model Selection by Use Case

**Never inline a model id at a callsite.** Use the roles in
`functions/src/utils/models.ts` (backend) / `types/ai-usage.ts` (frontend). Those two
files are hand-duplicated because `functions/tsconfig.json` pins `rootDir: "src"`;
`functions/src/utils/models.sync.test.ts` fails the build if they drift, because the
silent failure mode is mis-billing, not a crash.

| Use Case | Role | Model | Reason |
|----------|------|-------|--------|
| CSV column matching | `geminiLite` | `gemini-3.1-flash-lite` | Cheapest callable model; no thinking tokens on structured prompts |
| Document extraction | `geminiLite` | `gemini-3.1-flash-lite` | Native PDF/image support |
| Partner matching / company lookup | `geminiFlash` | `gemini-3.5-flash-lite` | Priced identically to the 2.5-flash it replaces |
| Chat/Agent (cloud) | `chatAgent` | Anthropic Claude | Complex reasoning, multi-step tasks |
| Chat/Agent (self-host) | `FIBUKI_CHAT_MODEL` | `gemini-3.8-flash` | Runs in fibuki-web via API key, not Vertex |

Google **retires model ids for new API-key consumers while Vertex keeps serving
them** — `gemini-2.5-flash` returns 404 on a current key but works on Vertex. So a
model that works in the Firebase build can be dead in the self-host build. Verify
against the API a deployment actually uses, not against the model list (which still
advertises retired ids).

Self-host can re-route any model without a code change:
`FIBUKI_AI_ROUTE_<model_with_underscores>=<provider>:<model>`. Note that cost
accounting keys on the model the CALLSITE requested, so a route override prices the
call at the original model's rate.

### Gemini via Vertex AI (Cloud Functions)

All Gemini calls use **Vertex AI** (not Google AI Studio). This provides:
- Service account auth (no API keys needed)
- Region: `europe-west1` (matches Firebase region)
- Project ID auto-detected from environment

**Pattern for new Gemini functions:**
```typescript
import { VertexAI } from "@google-cloud/vertexai";

const GEMINI_MODEL = "gemini-2.0-flash-lite-001";
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || "europe-west1";

function getProjectId(): string {
  return process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
}

// Usage
const vertexAI = new VertexAI({ project: getProjectId(), location: VERTEX_LOCATION });
const model = vertexAI.getGenerativeModel({ model: GEMINI_MODEL });
const response = await model.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
```

**Key files using Gemini:**
- `functions/src/import/matchColumns.ts` - CSV column matching
- `functions/src/extraction/geminiParser.ts` - Document extraction
- `functions/src/precision-search/geminiSearchHelper.ts` - Email search queries
- `functions/src/matching/matchFilePartner.ts` - Partner matching

### Anthropic Claude (Chat/Agent)

Used for the main chat interface and LangGraph agent. Requires `ANTHROPIC_API_KEY`.

## Authentication
- Firebase Auth with email/password and Google Sign-In
- Invite-only registration (admin must add email to `allowedEmails` collection)
- Admin system uses Firebase custom claims (`admin: true`)
- Super admin: Set via `SUPER_ADMIN_EMAIL` env var (auto-granted admin on first login)
- Auth context provided by `AuthProvider` in `/components/auth/`
- Protected routes use `ProtectedRoute` component

## Deployment

**`fibuki.com` runs the self-host stack on Hetzner, not Firebase.** The W4 cutover
moved it: the apex A record points at the box, Caddy terminates TLS, and the
Firebase App Hosting backend this section used to describe has been deleted
(`firebase apphosting:backends:list --project taxstudio-f12fb` returns nothing).

### Production (Hetzner, current)
- Pushing to `main` deploys, via `.github/workflows/deploy-hetzner.yml`: gate
  (typecheck, lint, self-host build, self-host suite), then rsync to
  `/opt/fibuki` and `docker compose up -d --build fibuki-api fibuki-web`
- Both containers are rebuilt every time. `fibuki-web` carries the frontend AND
  its server-side document IO; `caddy` is deliberately left running so it does
  not re-request certificates
- Commits touching only markdown or `docs/` skip the deploy (`paths-ignore`)
- Rollback is a revert commit. There is no blue/green
- Host, secrets, and the manual equivalent of every step:
  [`deploy/selfhost/README-hetzner.md`](deploy/selfhost/README-hetzner.md)

### Firebase (legacy, for the retained project only)
The sections below still describe the Firebase deployment. They apply to the
retained `taxstudio-f12fb` project, which is the rollback anchor until the soak
window closes (see [`docs/w4-cutover-runbook.md`](docs/w4-cutover-runbook.md)
step 9), and NOT to what serves `fibuki.com` today.

**Never delete `taxstudio-f12fb`:** it owns the Google OAuth client
(`GOOGLE_CLIENT_ID`) that Gmail connections on fibuki.com use. Its Firestore and
Storage rules are deny-all for clients (the frozen data copy serves no one);
they are not the access policy, `data-policy.ts` is.

### Cloud Functions
- Deploy manually: `firebase deploy --only functions`
- Region: `europe-west1`
- Deploy specific functions: `firebase deploy --only functions:functionName`
- **IMPORTANT**: Cloud Functions are NOT auto-deployed on push. When you create or modify Cloud Functions, you MUST deploy them after pushing:
  ```bash
  firebase deploy --only functions:fn1,functions:fn2
  ```
- CORS origins are configured in `createCallable()` wrapper (`functions/src/utils/createCallable.ts`). New callables using `createCallable()` inherit CORS automatically. Standalone `onCall()` functions must include the same CORS origins array.

### Firestore Rules & Indexes
- `firestore.rules` and `storage.rules` are deny-all on purpose (see above).
  They only change if the project is ever used again; a rollback restores the
  pre-cutover rules from git history.
- **NOT auto-deployed on push**. When modifying them, deploy after pushing:
  ```bash
  firebase deploy --only firestore:rules,storage --project taxstudio-f12fb
  firebase deploy --only firestore:indexes --project taxstudio-f12fb
  ```

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
