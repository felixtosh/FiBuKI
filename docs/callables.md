# Callables

Moved out of `CLAUDE.md` so it loads only when a callable is being added or changed. The pattern itself (all mutations go through a `createCallable()` callable) stays in `CLAUDE.md`.

## Example: Adding a new callable

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

## Available Callables

**Transactions:**

A Transaction dated in the Closed stretch (#794, ADR-0018) is refused by every edit and delete a User or a client can start, naming Closed Through: both update callables (the bulk one per row), `rollbackTransactionCallable` through `update_transaction`, the Partner, No-document Category, Accepted Receipt and Partial Payment callables and tools, `set_booking_accounts`, a suggestion's rejection and its undo, deleting or remapping its Import, `deleteTransactionsBySourceCallable` and `deleteSourceCallable` (whole, before anything is taken apart), a bank disconnect, a sync that replaces a Bank Account's rows, and a Cash Payment's correction and delete. The orphan cleanups keep a closed orphan. The browser cannot write Transactions at all. Inserts are never refused; a Cash Payment and a remap may not land before Tracked From. Automation is not yet held to it (#803).

- `updateTransactionCallable` - Write what a foreign or 0% line is for the UVA (`foreignSupplyKind`, `saleSupplyKind`); refuses any other field (#621)
- `bulkUpdateTransactionsCallable` - Write description, completion, Partner or no-receipt category onto many transactions; refuses any other field, and a Partner or category the caller may not use (#621)
- `deleteTransactionsBySourceCallable` - Delete all transactions for a source
- `acceptReceiptOnlyCallable` - Record or revoke an Accepted Receipt ruling on a receipt-only transaction (#165)
- `acceptPartialPaymentCallable` - Record or revoke an Accepted Partial Payment ruling on a tipped transaction the bank line does not cover (#554)
- `rollbackTransactionCallable` - Restore the values one history entry says an edit replaced, through `update_transaction`'s rules (only the fields an edit writes; #616)
- `addCashPaymentCallable` (`addCashPayment`) - Add one Cash Payment to a Cash Box by hand (#788). The Cash Payment writer (`functions/src/transactions/cashPayment.ts`) is the only code that creates one, MCP's `add_cash_payment` included: it refuses a Bank Account that is not a Cash Box and a Partner that is not the User's, takes a `YYYY-MM-DD` day and signed integer cents, stores no import job, CSV row, original row or dedupe hash (`addedByHand: true`), counts the row against the transaction quota, logs who added it from the caller (the UI `manual`, MCP and the chat `ai`), then runs Partner matching and the matcher's File suggestions on it
- `addCashPaymentFromFileCallable` (`addCashPaymentFromFile`) - Add a Cash Payment from a File (#789), in the same writer, MCP's `add_cash_payment_from_file` included. The File's day, gross amount (plus a printed tip; money in for an outgoing invoice), name and own Partner are defaults (`cashPaymentDefaults.ts`, which the File detail panel's dialog reads too); values sent win. Without a Cash Box id it takes the User's only one and refuses none or several, naming them. It refuses another User's File or Cash Box (not found) and a File already connected. The row is created by the File Connection writer's `connectFileToNewTransaction`, in one Firestore transaction with its connection (origin `manual`, `mcp` or `agent` from the caller), so a refused connect leaves no row and both activity logs record it
- `correctCashPaymentCallable` (`correctCashPayment`) / `deleteCashPaymentCallable` (`deleteCashPayment`) - Correct (day, signed amount, name, description) or delete one Cash Payment, in the same writer (#790, ADR-0017). Both refuse a Transaction without `addedByHand` (a CSV row on a Cash Box included) and a row whose day, or for a move the new day, falls in a month or quarter with a filed UVA record, naming the period. A correction logs one activity entry, before and after; one that changes nothing writes nothing. A delete takes the File Connections apart through the File Connection writer's `detachTransactions` (logged on each File, suggestions of it dropped), leaves the Files, then deletes the row. The general Transaction update callables keep refusing date, amount and name (#621). No MCP tool deletes

**AI tools:**
- `runToolCallable` (`runTool`) - Run one tool from `functions/src/tools/definitions.ts` as the session's User, through the handler MCP uses (#616)
- `submitChatFeedbackCallable` (`submitChatFeedback`) - Thumbs up or down (and a comment) on one chat turn, stored on its trace `chatTraces/{uid}_{turnId}`; the id is built from the caller's uid, so only a turn of their own (docs/buki-rubric.md)
- `listChatTracesCallable` (`listChatTraces`) - The newest chat traces with their rubric verdicts, for the admin trace page; admins only, decided from the verified token

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
- `assignPartnerToFileCallable` / `removePartnerFromFileCallable` - A File's Partner, through `functions/src/files/filePartner.ts`, the path MCP's `assign_partner_to_file` / `remove_partner_from_file` use too: the User's own or a Global Partner, the Partner worker cancelled on a manual assign, a removed automatic assignment recorded on the Partner (#627)
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

**Business identity (#632):**
- `saveIdentityCallable` (`saveIdentity`) - The settings screen's and the Partner panel's "this is me" save. The identity module (`functions/src/identity/identity.ts`) is the one writer of what the User enters into `users/{uid}/settings/userData`, MCP's `create_identity_entity` / `update_identity_entity` included: it normalises as the browser did, merges (the FinanzOnline status survives), refuses fields the identity does not hold and a Partner id that is not the User's own. The browser only reads the document. Server-side write-backs (the identity Partner sync, Partner merging, account import) still write it directly (#734)

**Fiscal Years (#794, ADR-0018):**
- `getFiscalYearsCallable` (`getFiscalYears`) - The User's fiscal year start month, Tracked From and Closed Through, with the latest change records. The first read stores the default with an `initial` record
- `updateFiscalYearsCallable` (`updateFiscalYears`) - Change any of the three; the only writer of `users/{uid}/settings/fiscalYears` beside MCP's `set_fiscal_years`, both through `fiscalYears/fiscalYears.ts`. Refuses a gap or a closed stretch inside untracked time, and Tracked From moved later over months holding Transactions or Files. Refuses a month after the current one. Reads, checks and writes in one transaction. Every change appends one record to `users/{uid}/fiscalYearChanges` (who, when, via, previous, next) and returns it; a refusal carries `details.reason`
- `previewUntrackedImportCallable` (`previewUntrackedImport`) - Read-only (#805). Takes an Import's rows counted per month and answers how many lie before Tracked From, per fiscal year, with the settings change for "track as closed" (Tracked From back to the earliest such fiscal year; while nothing is closed, Closed Through to the month before the old Tracked From) and "track as open" (only while nothing is closed). The Import page sends the chosen change to `updateFiscalYears`; first setup sends its picks there too, so neither is a second settings writer
- `getUntrackedFilesHintCallable` / `dismissUntrackedFilesHintCallable` (`getUntrackedFilesHint`, `dismissUntrackedFilesHint`) - Files dated before Tracked From are kept, never skipped; the hint counts the ones not yet seen per fiscal year, and dismissing stores the counts shown in `users/{uid}/settings/untrackedFilesHint` (server-only), so the hint comes back only for later documents
- `assignReceiptLostCategoryCallable` (`assignReceiptLostCategory`) / `removeNoReceiptCategoryCallable` (`removeNoReceiptCategory`) / `migrateNoReceiptCategoryRefsCallable` (`migrateNoReceiptCategoryRefs`) - The web's Receipt Lost, category removal and orphaned-category migration, moved server-side because Transactions are read-only for the browser. The first two refuse a closed Transaction; the migration keeps a closed Transaction's reference and counts it in `keptClosed`. Removal is one writer with MCP's `remove_no_receipt_category`

**UVA filing:**
- `markUvaPeriodFiledCallable` - Record what was filed for a period (append-only, editable figures); refused while the period has blockers
- `getUvaFiledStatusCallable` - Blockers, filed vs now per Kennzahl, and earlier filed periods whose figures moved

**Inbound email addresses (#626):**
- `createInboundEmailAddressCallable` / `updateInboundEmailAddressCallable` / `regenerateInboundEmailAddressCallable` / `deleteInboundEmailAddressCallable` - The table's only writers. The User sets the display name, allowed domains and active/paused; the daily limit and the counters are the server's, and a request naming them is refused. One active address per User: create returns the active one if there is one, and resuming or regenerating while another is active is refused (decided in a transaction on `users/{uid}/settings/inboundEmail`)

**Imports:**
- `bulkCreateTransactionsCallable` - Bulk create transactions from CSV. Skips rows before Tracked From and returns `untrackedCount` and `untrackedByFiscalYear`, as `import_transactions` and the bank syncs do (#794)
- `createImportRecordCallable` - Create import record
