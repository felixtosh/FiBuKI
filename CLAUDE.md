# Claude Code Instructions

## Project Overview
FiBuKI - A tax/accounting tool for managing bank transactions, receipts, and categorization.

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
   4. Export from /functions/src/index.ts
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
- `updateTransactionCallable` - Update a single transaction
- `bulkUpdateTransactionsCallable` - Update multiple transactions
- `deleteTransactionsBySourceCallable` - Delete all transactions for a source

**Files:**
- `connectFileToTransactionCallable` - Connect file to transaction
- `disconnectFileFromTransactionCallable` - Disconnect file from transaction
- `updateFileCallable` - Update file metadata
- `deleteFileCallable` - Soft or hard delete a file

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

External AI integrations (OpenClaw, Claude Desktop, ChatGPT) use a shared tool registry:

```
┌─────────────────────────────────────────────────────────────────┐
│                    EXTERNAL AI TOOLS                            │
│  OpenClaw  │  Claude Desktop (MCP)  │  ChatGPT  │  REST API     │
└─────────────────────────────────────────────────────────────────┘
                              │
                    HTTP + API Key Auth
                              │
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

**Note**: Chat assistant (`lib/agent/tools/`) has separate implementations for performance (direct Admin SDK reads). Writes are already unified via Cloud Function callables.

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
1. **Frontend scoring**: Call `/api/matching/score-files` which proxies to `scoreAttachmentMatchCallable`
2. **Agent tools**: Call `scoreAttachmentMatchCallable` directly via `callFirebaseFunction`
3. **Pre-computed scores**: Stored in `file.transactionSuggestions` (computed by `matchFileTransactions` trigger)
4. **NEVER** implement local `scoreResult()` or similar functions in hooks/components

**Key Files**:
- `functions/src/precision-search/scoreAttachmentMatch.ts` - Single source of truth for scoring
- `functions/src/precision-search/scoreAttachmentMatchCallable.ts` - Callable wrapper
- `app/api/matching/score-files/route.ts` - API route for frontend
- `functions/src/matching/matchFileTransactions.ts` - Pre-computes suggestions on file upload

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

### Generating Test Data
The app includes a test data toggle on the Bank Accounts page (`/sources`):
- **Enable Test Data**: Creates "Test Bank Account" with 100 sample transactions
- **Disable Test Data**: Removes the test source and all its transactions

### Test Data Files
- `/lib/test-data/generate-test-transactions.ts` - Generates test source + 100 transactions
- `/hooks/use-test-source.ts` - Hook for activating/deactivating test data

### Updating Test Data
When modifying transaction-related types, also update the test data generator:

**Files that require test data updates when changed:**
- `types/transaction.ts` - Transaction interface
- `types/source.ts` - TransactionSource interface
- `lib/import/field-definitions.ts` - Import field definitions

**Test data includes:**
- 85 realistic transactions (expenses: REWE, Amazon, Netflix, etc. / income: salary, freelance)
- 15 edge cases (large amounts, special characters, missing fields, duplicates)

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

| Use Case | Model | Reason |
|----------|-------|--------|
| CSV column matching | `gemini-2.0-flash-lite-001` | Fast, cheap, good enough for structured mapping |
| Document extraction | `gemini-2.0-flash-lite-001` | Native PDF/image support via Vertex AI |
| Partner matching | `gemini-2.0-flash-lite-001` | Simple text matching task |
| Chat/Agent | Anthropic Claude | Complex reasoning, multi-step tasks |

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

### Frontend (Next.js)
- Hosted on **Firebase App Hosting** (not Firebase Hosting - different service)
- Auto-deploys when pushing to `main` branch
- Region: `europe-west4`
- Domain: `fibuki.com`
- Backend name: `taxstudio`

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
- **NOT auto-deployed on push**. When modifying `firestore.rules` or `firestore.indexes.json`, deploy after pushing:
  ```bash
  firebase deploy --only firestore:rules
  firebase deploy --only firestore:indexes
  ```
