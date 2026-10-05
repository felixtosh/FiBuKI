/**
 * Centralized Tool Definitions
 *
 * Single source of truth for all MCP/API tool schemas.
 * Consumed by:
 * - handlers.ts (ToolName type + dispatch)
 * - mcp-server.ts (MCP protocol tool listing and annotations)
 * - mcp-api/index.ts (REST API tool listing)
 * - lib/data/generated-tool-definitions.ts (the web app's copy: the chat's
 *   wrappers, /api/openapi.json, llm.txt), regenerated and checked by CI
 *
 * A new tool is a definition here and a case in handlers.ts.
 */

import type { PlanFeatureKey } from "../billing/config";

/**
 * How a tool may change the User's account, for the MCP annotations clients
 * read to decide when to ask before a call. Hints, never authorization: every
 * handler still checks the User itself.
 * - read-only: cannot change any state
 * - write: an ordinary write inside the User's own account, reversible
 * - destructive: irreversible or hard to undo, so a client should confirm
 */
export type ToolAnnotationClass = "read-only" | "write" | "destructive";

export interface ToolDefinition {
  name: string;
  /** Required: a tool without a class does not compile (#616). */
  annotation: ToolAnnotationClass;
  /** Reaches outside the User's FiBuKI account (upload_file fetches a URL). */
  openWorld?: boolean;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** If set, tool is only available when user's plan has this feature enabled */
  requiredFeature?: PlanFeatureKey;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // =========================================================================
  // Sources
  // =========================================================================
  {
    name: "list_sources",
    annotation: "read-only",
    description: "List all bank accounts/sources for the user",
    inputSchema: {
      type: "object",
      properties: {
        includeInactive: { type: "boolean", description: "Also list inactive bank accounts (default false)" },
      },
    },
  },
  {
    name: "get_source",
    annotation: "read-only",
    description: "Get details of a specific bank account by ID",
    inputSchema: {
      type: "object",
      properties: { sourceId: { type: "string", description: "The bank account ID" } },
      required: ["sourceId"],
    },
  },
  {
    name: "create_source",
    annotation: "write",
    description: "Create a new bank account/source",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the bank account" },
        accountKind: {
          type: "string",
          enum: ["bank_account", "credit_card"],
          description: "Type of account (default: bank_account)",
        },
        iban: { type: "string", description: "IBAN (optional)" },
        currency: { type: "string", description: "Currency code (default: EUR)" },
      },
      required: ["name"],
    },
  },
  {
    name: "delete_source",
    annotation: "destructive",
    description: "Delete a bank account and all associated imports/transactions (cascade). Requires confirm: true.",
    inputSchema: {
      type: "object",
      properties: {
        sourceId: { type: "string", description: "The bank account ID to delete" },
        confirm: { type: "boolean", description: "Must be true to confirm deletion" },
      },
      required: ["sourceId", "confirm"],
    },
  },

  // =========================================================================
  // Transactions
  // =========================================================================
  {
    name: "list_transactions",
    annotation: "read-only",
    description:
      "List transactions with optional filters. Dates are YYYY-MM-DD (local timezone). Amounts in cents. " +
      "Returns { transactions, nextCursor, count, total, aggregates }. Pass nextCursor back as cursor for the next page. " +
      "search, the amount bounds and the has*/only* filters run over a window of the most recent 5000 matching rows: " +
      "`total` and `aggregates` (counts with/without a partner, a file, a no-receipt category, per category template) " +
      "cover every match in that window, and `scanTruncated: true` says the window was full, so the answer is partial, " +
      "not a total.",
    inputSchema: {
      type: "object",
      properties: {
        sourceId: { type: "string", description: "Filter by bank account ID" },
        dateFrom: { type: "string", description: "Start date inclusive (YYYY-MM-DD). Pushed into the query, applied before limit." },
        dateTo: { type: "string", description: "End date inclusive (YYYY-MM-DD). Pushed into the query, applied before limit." },
        search: { type: "string", description: "Substring match on name/description/partner. Applied after fetch so pagination is approximate when combined with cursor." },
        isComplete: { type: "boolean", description: "Filter by completion status" },
        minAmount: { type: "number", description: "Minimum absolute amount in cents (e.g. 4700 = 47.00)" },
        maxAmount: { type: "number", description: "Maximum absolute amount in cents" },
        partnerId: { type: "string", description: "Only transactions with this partner assigned" },
        hasPartner: { type: "boolean", description: "true = any partner assigned, false = none yet" },
        noReceiptCategoryId: { type: "string", description: "Only transactions in this no-receipt category (an id from list_no_receipt_categories)" },
        noReceiptCategoryTemplateId: {
          type: "string",
          enum: [
            "bank-fees",
            "interest",
            "bank-rewards",
            "internal-transfers",
            "payment-provider-settlements",
            "taxes-government",
            "payroll",
            "private-personal",
            "zero-value",
            "receipt-lost",
          ],
          description: "Only transactions in a no-receipt category made from this template ('private-personal' is 'private')",
        },
        hasNoReceiptCategory: { type: "boolean", description: "true = has a no-receipt category, false = none" },
        hasFile: { type: "boolean", description: "true = at least one file connected, false = none" },
        onlyIncome: { type: "boolean", description: "Only money in (positive amounts)" },
        onlyExpenses: { type: "boolean", description: "Only money out (negative amounts)" },
        limit: { type: "number", description: "Max results per page (default 50, max 500)" },
        cursor: { type: "string", description: "nextCursor from the previous response to fetch the next page" },
      },
    },
  },
  {
    name: "get_transaction",
    annotation: "read-only",
    description: "Get full details of a transaction by ID",
    inputSchema: {
      type: "object",
      properties: { transactionId: { type: "string", description: "The transaction ID" } },
      required: ["transactionId"],
    },
  },
  {
    name: "update_transaction",
    annotation: "write",
    description: "Update a transaction's description, completion status, or manual VAT-rate override (the override feeds the UVA calculation when no receipt resolves the rate). A change is recorded in the transaction's history; the reply then carries historyId and the new values (changes).",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: { type: "string", description: "The transaction ID" },
        description: { type: "string", description: "Description for tax purposes" },
        isComplete: { type: "boolean", description: "Mark as complete/incomplete" },
        vatRate: {
          type: ["number", "null"],
          description:
            "Manual VAT rate override for UVA derivation: one of 0, 4.9, 10, 13, 19, 20. Pass null to clear. The calculation still validates the rate against the transaction's period.",
        },
        isReverseCharge: {
          type: ["boolean", "null"],
          description:
            "Reverse-charge classification for UVA derivation: true forces the §19 service regime (KZ 057/066), false vetoes the automatic foreign-supplier heuristic, null clears and lets the heuristic decide.",
        },
        foreignSupplyKind: {
          type: ["string", "null"],
          enum: ["goods", "service", null],
          description:
            'Goods or service, for the foreign-regime classification: "goods" routes an EU acquisition to ig. Erwerb (KZ 070 + per-rate base + KZ 065) and a third-country one to the import lane (unresolved until EUSt is documented); "service" confirms reverse charge §19 (KZ 057/066). null clears, keeping the service heuristic flagged basis: "heuristic" for review. Applies only where a foreign supply is detected (isReverseCharge: true, or a foreign supplier UID on a zero-VAT document) - it never conjures a foreign regime on its own.',
        },
        saleSupplyKind: {
          type: ["string", "null"],
          enum: ["service-eu", "service-non-eu", "export-goods", null],
          description:
            'What a 0% sale is, for the UVA: "service-eu" or "service-non-eu" is a B2B service supplied abroad (§ 3a Abs 6), not taxable in Austria, so its net reaches no Kennzahl (an EU one also owes a Zusammenfassende Meldung); "export-goods" keeps it in KZ 011. Wins over a FiBuKI Invoice\'s setting and over detection. null clears, back to the Invoice setting or detection. Read only for the 0% part of a money-in transaction; the UVA report lists every 0% sale with its kind and where it came from.',
        },
      },
      required: ["transactionId"],
    },
  },
  {
    name: "accept_receipt_only",
    annotation: "write",
    description:
      "Record - or revoke - an Accepted Receipt ruling on a receipt-only transaction: a standing, recorded ruling (who, when, why, over which files) that no § 11 invoice is obtainable and the receipt is as good as the evidence will ever get, so the chase queue stops holding the line. It changes nothing else: documentationState stays receipt-only, isComplete, the UVA and the BMD export are untouched, and no Vorsteuer becomes claimable. The ruling goes stale on its own when the connected files or the documentation state change; revoke with revoke: true reverses it explicitly. If input VAT appears to be claimed on the line, the response carries a warning - never a refusal; deductibility stays the Tax Advisor's call.",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: { type: "string", description: "The transaction ID" },
        reason: {
          type: "string",
          description:
            "Why no § 11 invoice is obtainable (e.g. marketplace seller charges no VAT). Required unless revoking - the reason IS the record.",
        },
        revoke: {
          type: "boolean",
          description: "true removes the recorded ruling instead of making one",
        },
      },
      required: ["transactionId"],
    },
  },
  {
    name: "accept_partial_payment",
    annotation: "write",
    description:
      "Record - or revoke - an Accepted Partial Payment ruling on a transaction whose connected files carry a tip and whose bank amount is short of document total + tip: a recorded ruling (who, when, why, over which figures) that the shortfall is real - a split bill where only a share was paid, or an instalment - and not a mistyped tip. Without it the UVA lists such a line as tip-partial-payment and claims nothing, and the BMD export refuses it. With a live ruling the UVA claims the paid fraction of the document's Vorsteuer and the BMD export books the tip row scaled to the same fraction. Do not use it to make a mistyped tip go away - correct the tip with update_file_extraction instead. The ruling goes stale on its own when the connected files, a file's total or tip, or the bank amount change; revoke: true removes it. Requires at least one connected file with a tip.",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: { type: "string", description: "The transaction ID" },
        reason: {
          type: "string",
          description:
            "Why the shortfall is real (e.g. split the bill, paid my half). Required unless revoking - the reason IS the record.",
        },
        revoke: {
          type: "boolean",
          description: "true removes the recorded ruling instead of making one",
        },
      },
      required: ["transactionId"],
    },
  },
  {
    name: "list_transactions_needing_files",
    annotation: "read-only",
    description: "Find transactions without receipts (no files, no category). Returns { transactions, nextCursor, count }. `count` is the size of this page, not a total — page with nextCursor until it comes back null to see everything that still needs a receipt.",
    inputSchema: {
      type: "object",
      properties: {
        minAmount: { type: "number", description: "Minimum amount in cents" },
        limit: { type: "number", description: "Max results per page (default 50, max 500)" },
        cursor: { type: "string", description: "nextCursor from the previous response to fetch the next page" },
      },
    },
  },
  {
    name: "list_transactions_missing_invoice",
    annotation: "read-only",
    description:
      "Find transactions documented by a receipt only - money moved, a document is attached, but no invoice satisfying § 11 UStG was ever received, so no Vorsteuer may be claimed. These lines look complete everywhere else. Returns { transactions, nextCursor, count, acceptedCount } where each row carries the vendor, the amount, the date and the § 11 elements the attached document is missing, so a request to the supplier can name the defect. Lines with a live Accepted Receipt ruling (accept_receipt_only) are excluded; `acceptedCount` says how many this page's scan excluded. Like `count`, both are per page, not totals - page with nextCursor until it comes back null.",
    inputSchema: {
      type: "object",
      properties: {
        minAmount: { type: "number", description: "Minimum absolute amount in cents — the deductions worth chasing first" },
        limit: { type: "number", description: "Max results per page (default 50, max 500)" },
        cursor: { type: "string", description: "nextCursor from the previous response to fetch the next page" },
      },
    },
  },
  {
    name: "import_transactions",
    annotation: "destructive",
    description:
      "Import pre-mapped transactions into a source. Transactions must include date, amount, name, and currency. " +
      "Lines an earlier import already stored for the same bank account are skipped (same date, amount and reference), " +
      "so re-sending an overlapping export is safe; the response says how many in duplicateCount. " +
      "When a file is sent in several calls, pass the same importJobId on each so identical lines of that file are all kept.",
    inputSchema: {
      type: "object",
      properties: {
        sourceId: { type: "string", description: "The source/bank account ID to import into" },
        importJobId: {
          type: "string",
          description:
            "Optional. One id per file, repeated on every call that carries a chunk of it. Without it each call is its own import.",
        },
        transactions: {
          type: "array",
          description: "Array of transaction objects",
          items: {
            type: "object",
            properties: {
              date: { type: "string", description: "Transaction date (ISO format)" },
              amount: { type: "number", description: "Amount in cents (negative for expenses)" },
              currency: { type: "string", description: "Currency code (e.g. EUR)" },
              name: { type: "string", description: "Transaction name/payee" },
              description: { type: "string", description: "Optional description" },
              partner: { type: "string", description: "Optional partner/counterparty name" },
              reference: { type: "string", description: "Optional reference number" },
              partnerIban: { type: "string", description: "Optional partner IBAN" },
            },
            required: ["date", "amount", "currency", "name"],
          },
        },
      },
      required: ["sourceId", "transactions"],
    },
  },

  // =========================================================================
  // Files
  // =========================================================================
  {
    name: "list_files",
    annotation: "read-only",
    description: "List uploaded files (receipts/invoices) with match suggestions. Returns { files, nextCursor, count }. `count` is the size of this page, not a total — page with nextCursor until it comes back null to see every file.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Substring match on the file name and the extracted partner name" },
        partnerId: { type: "string", description: "Only files with this partner assigned" },
        dateFrom: { type: "string", description: "Document date (else upload date) on or after this day (YYYY-MM-DD)" },
        dateTo: { type: "string", description: "Document date (else upload date) on or before this day (YYYY-MM-DD)" },
        minAmount: { type: "number", description: "Minimum absolute document total in cents (e.g. 4700 = 47.00)" },
        maxAmount: { type: "number", description: "Maximum absolute document total in cents" },
        hasConnections: {
          type: "boolean",
          description: "true = matched, false = unmatched (leaves out Copies, which are never work)",
        },
        isCopy: {
          type: "boolean",
          description:
            "true = only Copies (second Files of a document already held, see mark_file_as_copy), false = no Copies. Every listed file carries isCopy.",
        },
        hasSuggestions: { type: "boolean", description: "Filter by suggestion availability" },
        needsDirectionReview: {
          type: "boolean",
          description:
            "true = only files whose invoice direction needs a person. Two ways in: the direction contradicts a transaction the file is linked to (an incoming document on money that left the account, or the reverse), or no direction was ever established. Each such file reports directionReviewReason, directionSuggested and directionConflictTransactionIds. Fix it with update_file_extraction's invoiceDirection.",
        },
        needsVatRateReview: {
          type: "boolean",
          description:
            "true = only files printing a VAT rate Austria does not have (anything outside 0/10/13/20 on the document's date). Each such file reports the offending rates in vatRatesOutsideSet. 11% is Versicherungssteuer, not VAT, and is not deductible — mark those with mark_file_vat_not_claimable.",
        },
        needsRksvCodeReview: {
          type: "boolean",
          description:
            "true = only till receipts whose printed VAT block disagrees with the receipt's RKSV Code (the signed QR code on Austrian till receipts) at 20, 10 or 13%. The printed block is what is stored; each such file reports the rates in rksvCodeDisagreeingRates. Check the paper, then correct the VAT with update_file_extraction if the printed block was misread.",
        },
        foreignRecipient: {
          type: "boolean",
          description:
            "true = only files whose document names a Leistungsempfänger who is not the user. Such a document can satisfy § 11 completely and still carry no Vorsteuer for this user (§ 12 Abs 1 Z 1): the supply was rendered to somebody else. Their VAT is excluded from the UVA and they are not offered as transaction matches. If the recipient IS the user under a different name, confirm_file_recipient_is_user lifts it.",
        },
        includeDeleted: {
          type: "boolean",
          description:
            "true = also return files that were deleted (each carries deletedAt). Deleted files are excluded by default. Restore one with restore_file.",
        },
        handCorrected: {
          type: "boolean",
          description:
            "true = only files whose extracted record a human corrected by hand. Each such file reports the fields in extractionCorrectedFields (field name -> when it was set) and the newest of them in extractionCorrectedAt. This is the exclusion list for a re-extraction sweep — retry_file_extraction refuses these files unless overwriteCorrections is passed.",
        },
        limit: { type: "number", description: "Max results per page (default 50, max 500)" },
        cursor: { type: "string", description: "nextCursor from the previous response to fetch the next page" },
      },
    },
  },
  {
    name: "get_file",
    annotation: "read-only",
    description:
      "Get file details including extracted data and suggestions. splitSuggestion, when present, means the Extraction read several separately issued invoices or Receipts in this one PDF: segments lists each one's pages with the invoice number, issuer and total it read; confirm or adjust it with split_file. splitFrom (on a part) and splitInto (on a split original) link the two sides of a Split.",
    inputSchema: {
      type: "object",
      properties: { fileId: { type: "string", description: "The file ID" } },
      required: ["fileId"],
    },
  },
  {
    name: "delete_file",
    annotation: "write",
    description:
      "Delete a file. The deletion is reversible: the file is hidden, its stored document is kept, and restore_file puts it back. Nothing on this surface destroys a document. The file is detached from every transaction it was connected to (no need to disconnect first); the response lists reopenedTransactions (now incomplete again, with date, amount and counterparty, so you can tell the user) separately from stillCompleteTransactions (another document or a no-receipt category keeps them complete). A document FiBuKI generated for an invoice is refused with GENERATED_INVOICE, naming the invoice; withdraw an issued invoice with cancel_invoice instead. Requires confirm: true.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file ID" },
        confirm: { type: "boolean", description: "Must be true to confirm the (reversible) deletion" },
      },
      required: ["fileId", "confirm"],
    },
  },
  {
    name: "restore_file",
    annotation: "write",
    description:
      "Restore a deleted file, making it visible again. Its previous transaction connections are NOT recreated; reconnect with connect_file_to_transaction where they still apply. Find deleted files with list_files includeDeleted: true.",
    inputSchema: {
      type: "object",
      properties: { fileId: { type: "string", description: "The deleted file's ID" } },
      required: ["fileId"],
    },
  },
  {
    name: "split_file",
    annotation: "write",
    description:
      "Split a PDF that holds several separately issued invoices or Receipts (an Amazon Marketplace order download with one Rechnung or Quittung per seller) into one file per invoice or Receipt. Give the page ranges in order; together they must cover every page exactly once. Each part is a new file holding those pages unedited; it is extracted, classified and partner-matched from scratch, and connected to every transaction the original was connected to. The original is then deleted (reversible), and restore_file refuses it while any part exists, so undo by deleting the parts first. Refused for a single-page PDF, an image, a deleted or encrypted file, a document FiBuKI generated for an invoice, and when a part's pages are already on file. Use get_file's splitSuggestion for the ranges when it has one.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file to split" },
        ranges: {
          type: "array",
          description: "The parts, in page order: each range's first and last page, 1-based and inclusive",
          items: {
            type: "object",
            properties: {
              from: { type: "integer", description: "First page of the part" },
              to: { type: "integer", description: "Last page of the part" },
            },
            required: ["from", "to"],
          },
        },
      },
      required: ["fileId", "ranges"],
    },
  },
  {
    name: "dismiss_split_suggestion",
    annotation: "write",
    description:
      "Say a file is one document, not several: removes get_file's splitSuggestion, and re-extraction never stores a new one for this file. Use it when the suggestion is wrong, for example one invoice that runs over several pages. It cannot be undone, but nothing is lost: split_file still splits the file by explicit page ranges.",
    inputSchema: {
      type: "object",
      properties: { fileId: { type: "string", description: "The file whose split suggestion is wrong" } },
      required: ["fileId"],
    },
  },
  {
    name: "connect_file_to_transaction",
    annotation: "write",
    description:
      "Connect a file (receipt) to a transaction, marking it complete. A pair that was previously rejected is refused with PAIR_REJECTED; lift the rejection with undismiss_transaction_suggestion first if the connection is genuinely intended.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file ID" },
        transactionId: { type: "string", description: "The transaction ID" },
      },
      required: ["fileId", "transactionId"],
    },
  },
  {
    name: "disconnect_file_from_transaction",
    annotation: "write",
    description: "Disconnect a file from a transaction",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file ID" },
        transactionId: { type: "string", description: "The transaction ID" },
      },
      required: ["fileId", "transactionId"],
    },
  },
  {
    name: "confirm_file_recipient_is_user",
    annotation: "write",
    description:
      "Rule that the recipient printed on this document is the user, despite the identity comparison saying otherwise — a maiden name, a c/o address, an employer's name on a folio, OCR noise. Lifts the foreignRecipient block: the file reclassifies, its VAT becomes claimable again and transaction matching is re-run for it. Nothing extracted is touched. Reversible with unconfirm_file_recipient_is_user.",
    inputSchema: {
      type: "object",
      properties: { fileId: { type: "string", description: "The file ID" } },
      required: ["fileId"],
    },
  },
  {
    name: "unconfirm_file_recipient_is_user",
    annotation: "write",
    description:
      "Withdraw a recipient confirmation, so the identity comparison's own verdict stands again. A document that names somebody else goes back to being excluded from Vorsteuer and from transaction matching.",
    inputSchema: {
      type: "object",
      properties: { fileId: { type: "string", description: "The file ID" } },
      required: ["fileId"],
    },
  },
  {
    name: "mark_file_vat_not_claimable",
    annotation: "write",
    description:
      "Record that the VAT this document prints must not be claimed as Vorsteuer, with the reason. Use for a figure that looks like VAT and is not: 11% on an insurance policy is Versicherungssteuer and insurance is VAT-exempt (insurance-tax), another public charge printed in the VAT column (levy), a 100% discount leaving nothing due (discount-to-zero), or private consumption (private). The UVA derivation then books the document's gross at 0% and lists the excluded VAT under nonClaimableVat instead of putting it on the receipt-chasing list as recoverable. Nothing extracted is touched — the document still says what it says. Reversible with unmark_file_vat_not_claimable.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file ID" },
        reason: {
          type: "string",
          enum: ["insurance-tax", "levy", "discount-to-zero", "private"],
          description: "Why the VAT is not deductible",
        },
        note: {
          type: "string",
          description: "Free-text detail stored with the reason, max 500 characters",
        },
      },
      required: ["fileId", "reason"],
    },
  },
  {
    name: "unmark_file_vat_not_claimable",
    annotation: "write",
    description:
      "Clear a file's non-claimable VAT marker, so its VAT is deductible again. The extracted figures never changed, so the derivation resumes reading them as printed.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file ID" },
      },
      required: ["fileId"],
    },
  },
  {
    name: "dismiss_transaction_suggestion",
    annotation: "write",
    description:
      "Reject a proposed file-to-transaction pair. Removes the suggestion from the file's suggestion list and records the rejection so re-scoring does not propose it again. Use for a genuinely wrong pair (coincidental amount or date, an own-side document scored against an expense line). Do NOT use when the pair is correct but the transaction already holds a document. Reversible with undismiss_transaction_suggestion.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file ID" },
        transactionId: { type: "string", description: "The transaction ID to reject" },
        reason: {
          type: "string",
          description: "Why the pair is wrong — stored with the rejection, max 500 characters",
        },
      },
      required: ["fileId", "transactionId"],
    },
  },
  {
    name: "undismiss_transaction_suggestion",
    annotation: "write",
    description:
      "Clear a previous rejection of a file-to-transaction pair, making it eligible to be suggested again. Does not itself regenerate the suggestion — the pair reappears when matching next runs for that file (a partner change, a precision search, or the UI's refresh-matches action), or can be scored on demand with score_file_transaction_match. The earlier rejection stays in the file's history.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file ID" },
        transactionId: { type: "string", description: "The transaction ID to un-reject" },
      },
      required: ["fileId", "transactionId"],
    },
  },
  {
    name: "mark_file_as_not_invoice",
    annotation: "write",
    description:
      "Flag a file as not an invoice (payment reminder, statement, anything that documents nothing). Clears its extracted data, hand corrections included (un-marking then re-extracts it), and takes it out of the unmatched-file queue. Refuses while the file is still connected to a transaction. Reversible with unmark_file_as_not_invoice. For a second copy of an invoice already held, use mark_file_as_copy instead: it records which File it is a copy of.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file ID" },
        reason: { type: "string", description: "Why it is not an invoice — stored on the file" },
      },
      required: ["fileId"],
    },
  },
  {
    name: "mark_file_as_copy",
    annotation: "write",
    description:
      "Record a file as a Copy of another file: a second File of the same invoice that arrived by another route (a mailbox Sync and a document system, a mailed copy of an invoice the user issued). A Copy holds no transaction connection and is never proposed as a match, so the original alone carries the coverage, the input VAT and the BMD export. If the Copy is connected, its connections are taken off it; where the original is not on that transaction, the connection moves to the original, so no transaction loses its document. Not a rejection. Also accepts a Copy suggestion (copySuggestion on the file). A FiBuKI-generated invoice is always the original and is refused as the Copy. A Receipt for the same charge as an invoice is NOT a Copy, nor is a payment reminder. Reversible with unmark_file_as_copy.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The File that is the Copy" },
        originalFileId: {
          type: "string",
          description: "The File it is a Copy of. If that File is itself a Copy, its original is used.",
        },
      },
      required: ["fileId", "originalFileId"],
    },
  },
  {
    name: "unmark_file_as_copy",
    annotation: "write",
    description:
      "Not a Copy: undo a Copy, or decline a Copy suggestion on a file. Stores a standing ruling for the pair, so it is never suggested or recorded again (marking the pair with mark_file_as_copy revokes the ruling). Undoing reconnects nothing: the file goes back to matching like any unconnected file.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The File that is (or was suggested as) the Copy" },
      },
      required: ["fileId"],
    },
  },
  {
    name: "make_file_the_original",
    annotation: "write",
    description:
      "Swap a Copy and its original: the given Copy becomes the original, the former original becomes its Copy, and the transaction connections move to the given file in the same act. Refused when the original is a FiBuKI-generated invoice, which is always the original.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The Copy to make the original" },
      },
      required: ["fileId"],
    },
  },
  {
    name: "link_correction",
    annotation: "write",
    description:
      "Link an Invoice Correction (a supplier's credit note, a Gutschrift that reduces an earlier invoice, a Rechnungskorrektur) to the File it corrects: the original invoice. The UVA and the BMD export then book the refund as a correction of that original, at the original's rates (a purchase refund reduces Vorsteuer in KZ 067), and an unlinked correction blocks the period's filing. Also accepts a suggestion (correctionSuggestions, see get_correction). The original must not itself be a correction. Reversible with unlink_correction.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The correction File (the credit note)" },
        originalFileId: { type: "string", description: "The File it corrects (the original invoice)" },
      },
      required: ["fileId", "originalFileId"],
    },
  },
  {
    name: "unlink_correction",
    annotation: "write",
    description:
      "Remove an Invoice Correction's link to its original, or decline one of its suggestions (pass originalFileId). The named File is never linked to this correction automatically again; link_correction on the pair revokes that. An unlinked correction blocks the period's filing until it is linked again or the line is reclassified.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The correction File" },
        originalFileId: {
          type: "string",
          description: "Optional: the suggested File to decline. Omit to remove the current link.",
        },
      },
      required: ["fileId"],
    },
  },
  {
    name: "get_correction",
    annotation: "read-only",
    description:
      "Inspect Invoice Corrections. With fileId: what the File reads as (invoice-correction or self-billed-invoice, and whether the signals disagree), its referenced invoice number, the File it corrects and the transactions that paid that File, its link suggestions, and the corrections linked to it when it is an original. With transactionId: the transactions related to it through a correction (the purchase a refund refunds, or the refunds of a purchase).",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "A File: a correction or an original" },
        transactionId: { type: "string", description: "A transaction: a refund or what it refunds" },
      },
    },
  },
  {
    name: "link_receipt",
    annotation: "write",
    description:
      "Link a Receipt (a payment confirmation: GitHub's or Stripe's receipt, a card terminal slip) to the invoice it pays. Both stay connected to the transaction and count once: the invoice's figures, its payment total raised to the Receipt's when that is larger, the difference booked as Trinkgeld without VAT. If one of the two Files is on a transaction and the other on none, the other is connected there too. Also accepts a pairing suggestion (receiptPairSuggestions, see get_receipt_link). One Receipt pays one invoice; the invoice must not itself be a Receipt, and neither File may be a Copy. Reversible with unlink_receipt.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The Receipt" },
        invoiceFileId: { type: "string", description: "The invoice it pays" },
      },
      required: ["fileId", "invoiceFileId"],
    },
  },
  {
    name: "unlink_receipt",
    annotation: "write",
    description:
      "Remove a Receipt Link, from the Receipt or from its invoice (pass the Receipt as otherFileId), or decline a pairing suggestion (pass otherFileId). The pair is recorded as declined on both Files and never linked or suggested automatically again; link_receipt on the pair revokes that. No transaction connection changes: both Files stay where they are and each counts as an ordinary File.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "A File of the pair" },
        otherFileId: {
          type: "string",
          description: "Optional: the other File (a suggested pair to decline, or a Receipt linked to fileId). Omit to remove fileId's own link.",
        },
      },
      required: ["fileId"],
    },
  },
  {
    name: "get_receipt_link",
    annotation: "read-only",
    description:
      "Inspect a File's Receipt Link: the invoice number it cites as paid, the invoice it is the Receipt of, the Receipts linked to it when it is an invoice, its pairing suggestions (with the File prefilled as the Receipt, or null when the person picks), and, with withCandidates, Files of the same Partner that may be linked by hand.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "A File: a Receipt or an invoice" },
        withCandidates: {
          type: "boolean",
          description: "Also list the Files of the same Partner this File may be linked to by hand",
        },
      },
      required: ["fileId"],
    },
  },
  {
    name: "unmark_file_as_not_invoice",
    annotation: "write",
    description:
      "Restore a file previously flagged as not an invoice. Re-opens extraction, which recovers the fields marking cleared. A file carrying hand corrections (extractionCorrectedFields) is refused, because the re-extraction would discard them; retry_file_extraction with overwriteCorrections re-extracts it as an invoice instead.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file ID" },
      },
      required: ["fileId"],
    },
  },
  {
    name: "update_file_extraction",
    annotation: "write",
    description:
      "Correct a file's extracted record by hand. Use when re-extraction cannot get there because the right value needs judgement the document does not state unambiguously — a Schlussrechnung printing both the full amount and the part already invoiced, VAT that is correctly read but not claimable, a one-cent OCR slip inside the reconciliation tolerance. Only the fields you pass are touched; pass null to clear one. The corrected total is NOT re-derived from the line items, so an amount that deliberately differs from them survives. Correcting anything VAT-bearing makes you the authority on the file: stored reconciliation flags and extraction-provenance markers are cleared, because they would otherwise outrank what you just set. Every correction records which fields you set and when, in extractionCorrectedFields — from then on retry_file_extraction refuses the file unless overwriteCorrections is passed, and list_files can return the corrected population with handCorrected: true. Takes the same fields as the file detail panel: the figures, the direction, the descriptive fields (partner, vatId, iban, address) and the additional fields, which carry the Due Date and Debit Date. Correcting the document date re-reads the Due Date and Debit Date against it. A correction that moves the amount, the date, the Due or Debit Date, the partner, the IBAN or the VAT ID re-scores the file's transaction suggestions; it never connects or disconnects a transaction.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file ID" },
        amount: {
          type: ["number", "null"],
          description: "Document total in cents. Negative is legal (a credit note).",
        },
        vatAmount: { type: ["number", "null"], description: "Document VAT in cents" },
        vatPercent: {
          type: ["number", "null"],
          description:
            "Document VAT rate, 0-100. Zero is a real correction — use it for a document whose VAT must not be claimed — and is not the same as null, which clears the rate.",
        },
        date: { type: ["string", "null"], description: "Document date as YYYY-MM-DD" },
        lineItems: {
          type: ["array", "null"],
          description:
            "Replace the itemisation wholesale. A row is a rate group with a label, not a bill of goods — four fields, no quantity and no unit price. Each item: description, amount (cents, GROSS — the amount includes its own VAT), vatPercent, vatAmount (cents).",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              amount: { type: "number" },
              vatPercent: { type: ["number", "null"] },
              vatAmount: { type: "number" },
            },
            required: ["amount"],
          },
        },
        tipAmount: {
          type: ["number", "null"],
          description:
            "Freiwilliges Trinkgeld in cents that the document does NOT print — the terminal took it and the Beleg never says so, which is why the bank line is larger than the invoice. It is stored BESIDE the total and never taken out of it: on such a document the printed total already is the VAT-bearing figure, so subtracting the tip would shrink the VAT base and under-claim. Only a human sets it; it is never inferred from the bank/document gap. A tip the document DOES print is already extracted into this field and needs no correction. Zero and null both clear it; a negative is refused. It is also bounded by what the document shows: it must be less than the document total, unless tipNotPrinted says the document does not print it. An over-large tip is refused rather than clamped.",
        },
        tipNotPrinted: {
          type: "boolean",
          description:
            "The tip being set is not printed on the invoice: the terminal took it on top of an invoice that is complete without it, so the document total does not bound it. No connected transaction is needed. Whether the bank line covers document + tip is checked at UVA time, not here: a tip not less than the bank line is impossible-tip, and a bank line short of document + tip is tip-partial-payment. The declaration is stored on the file as extractedTipBound.",
        },
        invoiceDirection: {
          type: ["string", "null"],
          enum: ["incoming", "outgoing", "unknown", null],
          description:
            "Which way the document points: incoming is a purchase, outgoing a sale. Setting it clears any direction-review flag on the file. null stores unknown. Direction is otherwise decided by comparing the document's parties against the user's identity data, so a document those data cannot place stays unknown until it is set here — and an unknown direction renders as a positive figure, indistinguishable from income.",
        },
        partner: {
          type: ["string", "null"],
          description:
            "The counterparty's name as the document prints it. Descriptive: written, never recorded as a hand correction. A changed name re-scores the file's transaction suggestions.",
        },
        vatId: { type: ["string", "null"], description: "The counterparty's VAT id (UID). Descriptive." },
        iban: { type: ["string", "null"], description: "The counterparty's IBAN. Descriptive." },
        address: { type: ["string", "null"], description: "The counterparty's address. Descriptive." },
        additionalFields: {
          type: ["array", "null"],
          description:
            "Replace the extra rows wholesale: read the file first (get_file, extractedAdditionalFields) and send every row back, changed or not, or the rows you leave out are deleted. Each row: key (one of invoiceNumber, customerNumber, dueDate, debitDate, serviceDate, paymentTerms, paymentMethod, orderNumber, deliveryNoteNumber, referenceNumber, poNumber), label (as printed), value; a key outside that list is refused. The Due Date and Debit Date are read from the dueDate and debitDate rows (value YYYY-MM-DD), against the document date: one earlier than the document date is not stored. Changing the date one of those rows states records dueDate or debitDate in extractionCorrectedFields, so a later re-extraction refuses the file. This is how to correct a Due Date or Debit Date.",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              label: { type: "string" },
              value: { type: "string" },
            },
            required: ["label", "value"],
          },
        },
      },
      required: ["fileId"],
    },
  },
  {
    name: "retry_file_extraction",
    annotation: "destructive",
    description:
      "Re-run extraction on a file. Use when a file extracted without erroring but produced nothing usable — no line items, no VAT amount, a wrong total — which is the case the UI's retry button did not cover. Returns { queued: true, fileId } at once: the extraction waits its turn and runs in the background, so read the file again later (get_file) — extractionComplete turns true when it is done, with extractionError set if it failed. Re-extracting resets partner and transaction matching for the file so both re-run against the new data; a manual partner assignment is kept. A file that already extracted cleanly needs force: true. A file carrying hand corrections is refused with HAND_CORRECTED, naming the fields a person set — re-extraction would discard them, so overwriting takes its own flag, per file. Sweep over list_files with handCorrected: true first if you want to know which files that will be.",
    requiredFeature: "aiExtraction",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file ID" },
        force: {
          type: "boolean",
          description:
            "Re-extract a file whose extraction completed without error. Required for that case, ignored otherwise.",
        },
        overwriteCorrections: {
          type: "boolean",
          description:
            "Re-extract a file whose record a human corrected, replacing what they set with whatever the model reads this time. Deliberately separate from force, which sweeps and the UI pass as a matter of habit — decide this one per file, having read the fields the refusal names.",
        },
      },
      required: ["fileId"],
    },
  },
  {
    name: "reclassify_documents",
    annotation: "destructive",
    description:
      "Re-run the § 11 UStG document classifier over every stored file and then re-derive the " +
      "documentation state of every transaction, whole account, in that order. This is what puts " +
      "invoice/receipt on records that were stored before the classifier existed or before a rule " +
      "fix — it never re-extracts, spends no AI call and touches no extracted field, so a hand " +
      "correction cannot be destroyed. Defaults to a dry run: pass dryRun=false to write. Writes " +
      "only where the value actually moved, so a second run in a row writes nothing. Returns " +
      "summary counts only — by document type, by basis reason and by documentation state, never " +
      "per-file rows. Inspect the result with list_transactions_missing_invoice.",
    inputSchema: {
      type: "object",
      properties: {
        dryRun: {
          type: "boolean",
          description:
            "Default true — classify and report only, nothing written. Pass false to persist.",
        },
      },
    },
  },
  {
    name: "auto_connect_file_suggestions",
    annotation: "write",
    description: "Auto-connect files to transactions above confidence threshold",
    requiredFeature: "aiMatching",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Specific file ID (optional)" },
        minConfidence: { type: "number", description: "Min confidence 0-100 (default 89)" },
      },
    },
  },
  {
    name: "upload_file",
    annotation: "write",
    openWorld: true,
    description: "Upload a file from a URL or base64 data. Byte-identical re-uploads create nothing: the existing file is returned with duplicate: true.",
    requiredFeature: "fileUpload",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public https URL to download the file from (port 443, up to 25 MB). Private, local and non-https addresses are refused; use base64 for those." },
        file: {
          type: "object",
          description: "A file the user attached in the chat (ChatGPT fills this in). Alternative to url and base64.",
          properties: {
            download_url: { type: "string", description: "Short-lived https link to the file." },
            file_id: { type: "string", description: "The chat platform's id for the file." },
          },
          required: ["download_url"],
        },
        base64: { type: "string", description: "Base64-encoded file content (alternative to url)" },
        fileName: { type: "string", description: "File name with extension" },
        mimeType: { type: "string", description: "MIME type (e.g. application/pdf, image/jpeg)" },
      },
      required: ["fileName", "mimeType"],
    },
  },
  {
    name: "get_period_status",
    annotation: "read-only",
    description:
      "How far the bookkeeping for a period is: per month, how many Transactions are covered (a File connected or a " +
      "No-document Category), still missing a receipt, or parked on the plan limit, plus the newest missing lines and " +
      "how many Matches wait for a yes. Defaults to the last three months. Shows a progress board in clients that " +
      "support widgets. Read-only; the coverage rules are the same ones list_transactions_needing_files uses.",
    inputSchema: {
      type: "object",
      properties: {
        dateFrom: { type: "string", description: "First day, YYYY-MM-DD. Defaults to the first of the month two months ago." },
        dateTo: { type: "string", description: "Last day, YYYY-MM-DD. Defaults to today." },
      },
    },
  },
  {
    name: "list_pending_matches",
    annotation: "read-only",
    description:
      "Files FiBuKI has matched to a Transaction but nobody has connected yet, best first, with FiBuKI's own " +
      "confidence. Shows a review list in clients that support widgets. Connect one with connect_file_to_transaction, " +
      "refuse one with dismiss_transaction_suggestion, or connect all at the bar with auto_connect_file_suggestions. " +
      "Read-only; never re-score.",
    inputSchema: {
      type: "object",
      properties: {
        minConfidence: { type: "number", description: "Lowest confidence to list (0-100). Default 85." },
        limit: { type: "number", description: "Rows to return, 1-50. Default 20." },
      },
    },
  },
  {
    name: "score_file_transaction_match",
    annotation: "read-only",
    description:
      "Score how well a file matches a transaction (0-100 confidence), with the same scorer the matching uses. Also says whether matching could propose the pair: `ineligible` names why the file is never matched (deleted, copy, not-invoice, foreign-recipient), `hidden` why the pair is held back from suggestions (rejected, over-quota). Both null when it could.",
    requiredFeature: "aiMatching",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file ID" },
        transactionId: { type: "string", description: "The transaction ID" },
      },
      required: ["fileId", "transactionId"],
    },
  },

  // =========================================================================
  // Identity (the user's own entities — used as `issuer` on invoices)
  // =========================================================================
  {
    name: "list_identity_entities",
    annotation: "read-only",
    description: "List the user's identity entities (personalEntity + companies). Each entry has id, name, type (person|company), optional vatId, ibans[], and optional address. Use the returned id as `issuerEntityId` in update_invoice / create_invoice.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "update_identity_entity",
    annotation: "write",
    description: "Patch an existing identity entity (personal or company). Accepts a sparse patch of name, vatId, ibans (full replacement array), aliases, and address ({street, postalCode, city, country}). Use this to bring an entity up to invoice-ready state without going through the settings UI.",
    inputSchema: {
      type: "object",
      properties: {
        entityId: { type: "string", description: "Identity entity id (from list_identity_entities)" },
        patch: {
          type: "object",
          description: "Sparse patch — only include fields you want to change",
          properties: {
            name: { type: "string" },
            vatId: { type: "string" },
            ibans: { type: "array", items: { type: "string" } },
            aliases: { type: "array", items: { type: "string" } },
            address: {
              type: "object",
              properties: {
                street: { type: "string" },
                postalCode: { type: "string" },
                city: { type: "string" },
                country: { type: "string" },
              },
            },
          },
        },
      },
      required: ["entityId", "patch"],
    },
  },

  // =========================================================================
  // Partners
  // =========================================================================
  {
    name: "create_identity_entity",
    annotation: "write",
    description:
      "Create the user's identity: their personal entity (a freelancer) or a company they run. " +
      "Use it when list_identity_entities is empty, then update_identity_entity for later changes. " +
      "FiBuKI needs it to tell the user's own issued invoices from the invoices they receive, so ask for the " +
      "name, the UID (vatId, like ATU12345678), their own IBANs and any other names the business uses, and show " +
      "what you will save before saving. Refuses a second personal entity or a company with the same name.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["person", "company"], description: "person = the user as an individual, company = a business they run" },
        name: { type: "string", description: "Name as it appears on invoices" },
        vatId: { type: "string", description: "UID, e.g. ATU12345678 (optional)" },
        ibans: { type: "array", items: { type: "string" }, description: "The user's own IBANs, so transfers between their accounts are recognised (optional)" },
        aliases: { type: "array", items: { type: "string" }, description: "Other names or spellings the business uses (optional)" },
        address: {
          type: "object",
          description: "Postal address for issued invoices (optional)",
          properties: {
            street: { type: "string" },
            postalCode: { type: "string" },
            city: { type: "string" },
            country: { type: "string", description: "ISO 3166-1 alpha-2, e.g. AT" },
          },
        },
      },
      required: ["type", "name"],
    },
  },
  {
    name: "get_onboarding_status",
    annotation: "write",
    description:
      "Where the user is in setting up FiBuKI: identity, mailbox, bank account, transactions, first partner, first document. " +
      "Each step is done, skipped or open, with the page on fibuki.com where it is done. Records any step the user's data " +
      "has completed since the last look, using the same rules as the web app, so call it at the start of a session and " +
      "after the user finished something. Starts onboarding for a user who has none.",
    inputSchema: {
      type: "object",
      properties: {
        origin: {
          type: "string",
          enum: ["web", "chatgpt", "codex", "claude", "api"],
          description: "Which assistant is calling. Only used the first time, to remember where the user came from.",
        },
      },
    },
  },
  {
    name: "skip_onboarding_step",
    annotation: "write",
    description:
      "Skip one onboarding step the user does not want (for example the mailbox step when they prefer to use their " +
      "assistant's mail). Only on the user's say-so. Returns the new status.",
    inputSchema: {
      type: "object",
      properties: {
        step: {
          type: "string",
          enum: ["set_identity", "connect_email", "add_bank_account", "import_transactions", "assign_partner", "attach_file"],
          description: "The step to skip",
        },
      },
      required: ["step"],
    },
  },
  {
    name: "list_partners",
    annotation: "read-only",
    description:
      "List user partners with optional search. Returns { partners, nextCursor, count } — `count` is " +
      "the size of this page, not a total; page with nextCursor until it comes back null to see every " +
      "partner. Each partner carries `billingCycle`: the effective " +
      "cycle plus the learned and declared halves it was resolved from, one entry per recurrence " +
      "(null when the partner does not bill on a schedule).",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Search in partner name, aliases and VAT ID" },
        limit: { type: "number", description: "Max results per page (default 50, max 500)" },
        cursor: { type: "string", description: "nextCursor from the previous response to fetch the next page" },
      },
    },
  },
  {
    name: "get_partner",
    annotation: "read-only",
    description:
      "Get partner details by ID, including `billingCycle`: the effective cycle plus the learned " +
      "and declared halves it was resolved from, one entry per recurrence (a partner can bill in " +
      "more than one amount band). A partner merged away by merge_partners reads back as itself " +
      "with isActive false, `mergedInto` and `survivor` ({ id, name }): switch to the survivor's id.",
    inputSchema: {
      type: "object",
      properties: { partnerId: { type: "string", description: "The partner ID" } },
      required: ["partnerId"],
    },
  },
  {
    name: "set_partner_billing_cycle",
    annotation: "write",
    description:
      "Declare, change or clear the DECLARED billing cycle of a partner. A declaration wins over " +
      "what Fibuki learned from the transaction history; the learned half stays visible beside it " +
      "and is never touched here. Pass one recurrence or an array of them (a partner can bill in " +
      "more than one amount band), or `declared: null` to clear every declaration and fall back to " +
      "what was learned.",
    inputSchema: {
      type: "object",
      properties: {
        partnerId: { type: "string", description: "The partner ID" },
        declared: {
          description:
            "The declared recurrence, an array of recurrences, or null to clear. Give either " +
            "`cadence` or `frequencyDays`.",
          properties: {
            cadence: {
              type: "string",
              enum: ["weekly", "monthly", "quarterly", "yearly"],
              description: "Named cadence — 7, 30, 90 or 365 days",
            },
            frequencyDays: {
              type: "number",
              description: "Days between charges, for a cadence with no name (every N days)",
            },
            amountBand: {
              type: "number",
              description:
                "Absolute amount in cents this recurrence bills, when the partner has more than " +
                "one (e.g. a weekly API charge beside a monthly subscription). Derived from " +
                "expectedAmountMin/Max when those are given.",
            },
            expectedAmountMin: { type: "number", description: "Lowest expected amount in cents" },
            expectedAmountMax: { type: "number", description: "Highest expected amount in cents" },
            currency: {
              type: "string",
              description:
                "Currency the recurrence is billed in (e.g. USD) — a USD subscription stays one " +
                "recurrence although the booked EUR amount drifts",
            },
            documentExpectation: {
              type: "string",
              enum: ["invoice", "no-receipt-category", "nothing"],
              description:
                "What each charge is expected to carry (default: invoice). Use 'nothing' for " +
                "charges that by rule never produce a document (bank fees, SVS, insolvency " +
                "instalments) so they never read as missing one.",
            },
          },
        },
      },
      required: ["partnerId", "declared"],
    },
  },
  {
    name: "list_recurring_partners",
    annotation: "read-only",
    description:
      "List the partners that bill on a schedule, with everything a subscription view needs per " +
      "partner: the billing cycle, the last charge seen (date, amount in the billed currency and " +
      "in EUR, transaction id), the next expected charge window, and how many of its charges in " +
      "the date range carry their expected document. `recurrences` splits all of that per amount " +
      "band, so a vendor billing weekly and monthly reads as two rows. Amounts are absolute cents; " +
      "`amountEur` is null when the account is not booked in EUR. Returns " +
      "{ partners, nextCursor, count, dateFrom, dateTo } — pass nextCursor back as `cursor` for " +
      "the next page. Up to 200 charges per partner, ending at dateTo, are read.",
    inputSchema: {
      type: "object",
      properties: {
        dateFrom: {
          type: "string",
          description: "Coverage range start, inclusive (YYYY-MM-DD). Default: 13 months before dateTo.",
        },
        dateTo: {
          type: "string",
          description: "Coverage range end, inclusive (YYYY-MM-DD). Default: today.",
        },
        limit: { type: "number", description: "Max partners per page (default 25, max 100)" },
        cursor: { type: "string", description: "nextCursor from the previous response" },
      },
    },
  },
  {
    name: "create_partner",
    annotation: "write",
    description: "Create a new user partner for transaction matching",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Partner/company name" },
        aliases: { type: "array", items: { type: "string" }, description: "Alternative names" },
        vatId: { type: "string", description: "VAT ID (e.g. ATU12345678)" },
        ibans: { type: "array", items: { type: "string" }, description: "Partner IBANs" },
        website: { type: "string", description: "Partner website" },
        country: { type: "string", description: "Country code (e.g. AT, DE)" },
      },
      required: ["name"],
    },
  },
  {
    name: "update_partner",
    annotation: "write",
    description:
      "Edit a user partner: the same fields create_partner takes. Only the fields you pass are " +
      "written. `aliases` and `ibans` REPLACE the stored lists wholesale, so read the partner " +
      "first (get_partner or list_partners), change the list, and write the whole list back; " +
      "pass [] to clear it. Use this to strip a wrong alias, e.g. an Invoicing Agent's name a " +
      "partner learned by mistake. To fold a duplicate partner into another, use merge_partners, " +
      "not an alias copy. A VAT ID is checked against the EU VIES register and stored either way; " +
      "vatIdCheck in the reply says what VIES answered ({ vatId, valid, name, error }; valid is " +
      "null when VIES could not be asked). Returns the partner as get_partner does, plus " +
      "vatIdCheck when you passed a VAT ID.",
    inputSchema: {
      type: "object",
      properties: {
        partnerId: { type: "string", description: "The partner ID" },
        name: { type: "string", description: "Partner/company name" },
        aliases: {
          type: "array",
          items: { type: "string" },
          description: "Alternative names. Replaces the stored list.",
        },
        vatId: { type: "string", description: "VAT ID (e.g. ATU12345678); checked via VIES; empty string clears it" },
        ibans: {
          type: "array",
          items: { type: "string" },
          description: "Partner IBANs. Replaces the stored list.",
        },
        website: { type: "string", description: "Partner website; empty string clears it" },
        country: { type: "string", description: "Country code (e.g. AT, DE)" },
      },
      required: ["partnerId"],
    },
  },
  {
    name: "merge_partners",
    annotation: "destructive",
    description:
      "Merge duplicate partners: fold one or more losing partners into a named survivor. The " +
      "same operation as the Partners page. Transactions, files and invoices pointing at a loser " +
      "move to the survivor; each loser's name and aliases join the survivor's aliases; the " +
      "losers become Merged Partners (inactive, gone from list_partners, get_partner names the " +
      "survivor). CANNOT BE UNDONE: requires confirm: true. Partners holding different VAT IDs " +
      "are refused unless you ALSO pass confirmVatIdConflict: true, a separate claim that the " +
      "differing VAT IDs really are one business. Refused: merging into a Merged Partner, and " +
      "merging a bank account's own partner in either role, loser or survivor. Nothing is re-matched: " +
      "`rematchPreview.newlyMatchable` counts unmatched transactions the survivor would now hit, " +
      "and partner_rematch_report is the reviewed path to act on them. Returns mergedPartnerIds, " +
      "aliasesAdded, repointed counts (transactions, files, invoices, ...), conflicts and " +
      "rematchPreview.",
    inputSchema: {
      type: "object",
      properties: {
        survivorId: { type: "string", description: "The partner that lives" },
        loserIds: {
          type: "array",
          items: { type: "string" },
          description: "The partners merged into the survivor (at most 50)",
        },
        confirm: {
          type: "boolean",
          description: "Must be true: a merge cannot be undone",
        },
        confirmVatIdConflict: {
          type: "boolean",
          description:
            "Set true only when the partners hold different VAT IDs and you have established they " +
            "are still the same business (usually one VAT ID is a wrong extraction)",
        },
      },
      required: ["survivorId", "loserIds", "confirm"],
    },
  },
  {
    name: "assign_partner_to_transaction",
    annotation: "write",
    description: "Assign a partner to a transaction for categorization",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: { type: "string", description: "The transaction ID" },
        partnerId: { type: "string", description: "The partner ID" },
      },
      required: ["transactionId", "partnerId"],
    },
  },
  {
    name: "remove_partner_from_transaction",
    annotation: "write",
    description: "Remove a partner assignment from a transaction",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: { type: "string", description: "The transaction ID" },
      },
      required: ["transactionId"],
    },
  },
  {
    name: "assign_partner_to_file",
    annotation: "write",
    description:
      "Assign a partner to a file (receipt/invoice), as a person does in the UI: recorded as a " +
      "manual assignment (partnerMatchedBy: \"manual\"), which automatic partner matching never " +
      "overwrites. Replaces any partner the file had. The partner reaches connected transactions " +
      "the same way a UI assignment does. The file's extracted name may be learned as an alias of " +
      "the partner, except a name the extraction recorded as the Invoicing Agent.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file ID" },
        partnerId: { type: "string", description: "The partner ID" },
      },
      required: ["fileId", "partnerId"],
    },
  },
  {
    name: "remove_partner_from_file",
    annotation: "write",
    description:
      "Remove the partner assignment from a file. If the partner had been assigned automatically " +
      "(auto or suggestion), the pair is recorded as a false positive on the partner so matching " +
      "does not suggest it again; a manual assignment is simply cleared.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file ID" },
      },
      required: ["fileId"],
    },
  },
  {
    name: "partner_rematch_report",
    annotation: "read-only",
    description:
      "READ-ONLY. Re-runs the current partner matcher over transactions that ALREADY have a partner " +
      "assigned and returns only the cases where its answer differs from what is stored: a different " +
      "partner would be applied, or nothing would be applied because no candidate reaches the " +
      "auto-apply threshold. Writes nothing — no assignment is changed and no false positive is " +
      "recorded. Use it to review assignments made before a matcher fix; partner matching itself skips " +
      "any transaction that already has a partner, so those are never re-scored on their own. " +
      "An assignment that a connected file backs with the same partner is supported evidence the " +
      "bank-data matcher cannot see: it is left out and counted in `fileBacked`. " +
      "Counts cover every evaluated transaction; `rows` is capped by `limit` and sets `truncated`.",
    inputSchema: {
      type: "object",
      properties: {
        minConfidence: {
          type: "number",
          description: "Only stored assignments with confidence >= this value",
        },
        maxConfidence: {
          type: "number",
          description: "Only stored assignments with confidence <= this value",
        },
        assignedBefore: {
          type: "string",
          description:
            "ISO 8601 instant — only assignments recorded before it. Transactions whose " +
            "automationHistory has no partner_assigned entry are kept (they are older, not newer).",
        },
        matchedBy: {
          type: "array",
          items: { type: "string" },
          description:
            "Which partnerMatchedBy values to review. Default [\"auto\",\"ai\"]; pass [\"manual\"] " +
            "only to inspect human assignments, which should never be mechanically re-matched.",
        },
        includeAgreements: {
          type: "boolean",
          description:
            "Also return transactions where the matcher agrees (default false, disagreements only)",
        },
        limit: {
          type: "number",
          description: "Max rows to return (default 50, max 500)",
        },
      },
    },
  },

  {
    name: "rematch_assigned_partners",
    annotation: "destructive",
    description:
      "Re-run the current partner matcher over transactions that already have an AUTO-assigned " +
      "partner, whole account, and write the corrected answer WITHOUT recording a false positive — " +
      "unlike remove_partner_from_transaction, which blacklists the pair forever. Defaults to a dry " +
      "run: pass dryRun=false to write. Reassigns where the matcher now picks a different partner and " +
      "keeps where it agrees; an assignment it no longer reproduces is reported but left alone unless " +
      "clearUnconfirmed=true. Never touches manual, suggestion or ai assignments, nor one that a " +
      "connected file backs with the same partner. Review with partner_rematch_report first.",
    inputSchema: {
      type: "object",
      properties: {
        dryRun: {
          type: "boolean",
          description:
            "Default true — plan only, nothing written. Pass false to apply the plan.",
        },
        clearUnconfirmed: {
          type: "boolean",
          description:
            "Default false — an assignment the matcher no longer reproduces is reported as " +
            "skip_clear_disabled and left in place, so the run applies only the reassignments it can " +
            "prove. Pass true to also clear those, which is a much larger write set.",
        },
        minConfidence: {
          type: "number",
          description: "Only stored assignments with confidence >= this value",
        },
        maxConfidence: {
          type: "number",
          description: "Only stored assignments with confidence <= this value",
        },
        assignedBefore: {
          type: "string",
          description:
            "ISO 8601 instant — only assignments recorded before it (e.g. the deploy time of a " +
            "matcher fix). Transactions with no recorded assignment time are kept.",
        },
        maxWrites: {
          type: "number",
          description:
            "Refuse to apply if the plan exceeds this many writes (default 1000). The run aborts " +
            "before writing anything rather than applying half a plan.",
        },
        includeKept: {
          type: "boolean",
          description: "Include untouched (agreeing) transactions in rows (default false)",
        },
        limit: {
          type: "number",
          description: "Max rows to return (default 100, max 1000). Counts cover the whole plan.",
        },
      },
    },
  },

  // =========================================================================
  // Categories
  // =========================================================================
  {
    name: "list_no_receipt_categories",
    annotation: "read-only",
    description: "List categories for transactions that don't need receipts",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "assign_no_receipt_category",
    annotation: "write",
    description: "Assign a no-receipt category to a transaction",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: { type: "string", description: "The transaction ID" },
        categoryId: { type: "string", description: "The category ID" },
      },
      required: ["transactionId", "categoryId"],
    },
  },
  {
    name: "remove_no_receipt_category",
    annotation: "write",
    description: "Remove a no-receipt category from a transaction",
    inputSchema: {
      type: "object",
      properties: { transactionId: { type: "string", description: "The transaction ID" } },
      required: ["transactionId"],
    },
  },

  // =========================================================================
  // UVA (read-only)
  // =========================================================================
  {
    name: "get_uva_report",
    annotation: "read-only",
    description:
      "Read the UVA figures for one period: the same Kennzahlen, derived by the same calculation, " +
      "that the reports page shows for that period. Read-only: FiBuKI derives and reconciles the " +
      "UVA, it does not file it, and this tool changes nothing. Amounts in cents. Returns " +
      "{ period (with start/end calendar days, Europe/Vienna), kennzahlen (keyed by Kennzahl, " +
      "e.g. \"000\", \"060\", \"095\"), totalOutputVat, totalInputVat, balance (KZ 095: " +
      ">0 Zahllast, <0 Gutschrift), unresolved (transactions still needing a receipt or " +
      "rate), transactionCount }. A period with no data returns zeroed figures.",
    inputSchema: {
      type: "object",
      properties: {
        year: { type: "number", description: "Calendar year, e.g. 2026" },
        period: {
          type: "number",
          description: "Month (1-12) when type is monthly, quarter (1-4) when type is quarterly",
        },
        type: {
          type: "string",
          enum: ["monthly", "quarterly"],
          description: "The UVA period length",
        },
      },
      required: ["year", "period", "type"],
    },
  },

  // =========================================================================
  // Invoicing
  // =========================================================================
  {
    name: "create_invoice",
    annotation: "write",
    description:
      "Create a new draft invoice for a customer (partner). Amounts in cents, net (pre-VAT). Returns the new invoiceId and a placeholder DRAFT-XXX number. The real number is allocated when the invoice is issued.",
    inputSchema: {
      type: "object",
      properties: {
        partnerId: { type: "string", description: "Recipient partner ID" },
        partnerType: {
          type: "string",
          enum: ["user", "global"],
          description: "Partner scope (default: user)",
        },
        lineItems: {
          type: "array",
          description: "Invoice line items (at least one required to issue)",
          items: {
            type: "object",
            properties: {
              description: { type: "string", description: "Item description" },
              quantity: { type: "number", description: "Quantity" },
              unitPrice: {
                type: "number",
                description: "Unit price in cents, net (pre-VAT)",
              },
              vatRate: {
                type: "number",
                description: "VAT rate in percent (default 20)",
              },
            },
            required: ["description", "quantity", "unitPrice"],
          },
        },
        issueDate: {
          type: "string",
          description: "ISO date (YYYY-MM-DD). Defaults to today.",
        },
        paymentTerms: {
          type: "string",
          description: "Free text e.g. 'Payable within 30 days'",
        },
        currency: { type: "string", description: "ISO 4217 (default EUR)" },
        notes: { type: "string", description: "Free-text footer note" },
        supplyAbroad: {
          type: "boolean",
          description:
            "Service, place of supply abroad (§ 3a Abs 6): a B2B service to a customer outside Austria. Forces every line to 0%, prints the reverse-charge note (EU customer) or the not-taxable note (outside the EU), and records the sale as not taxable in Austria for the UVA. Issuing then requires a customer country outside Austria, and for an EU customer both UIDs.",
        },
        issuerEntityId: {
          type: "string",
          description: "Identity entity to issue from (default: first/default)",
        },
        issuerIban: {
          type: "string",
          description: "Specific IBAN to use (must belong to the entity)",
        },
      },
      required: ["partnerId"],
    },
  },
  {
    name: "update_invoice",
    annotation: "write",
    description:
      "Patch a draft invoice. Server recomputes totals and due date. Rejected if status is not 'draft'.",
    inputSchema: {
      type: "object",
      properties: {
        invoiceId: { type: "string", description: "Invoice ID" },
        patch: {
          type: "object",
          description: "Fields to update (partial)",
          properties: {
            partnerId: { type: "string" },
            partnerType: { type: "string", enum: ["user", "global"] },
            issuerEntityId: { type: "string" },
            issuerIban: { type: "string" },
            issueDate: { type: "string", description: "ISO date YYYY-MM-DD" },
            paymentTerms: { type: "string" },
            currency: { type: "string" },
            lineItems: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  description: { type: "string" },
                  quantity: { type: "number" },
                  unitPrice: { type: "number" },
                  vatRate: { type: "number" },
                },
              },
            },
            notes: { type: "string" },
            supplyAbroad: {
              type: "boolean",
              description:
                "Service, place of supply abroad (§ 3a Abs 6): a B2B service to a customer outside Austria. Forces every line to 0%, prints the reverse-charge note (EU customer) or the not-taxable note (outside the EU), and records the sale as not taxable in Austria for the UVA. Issuing then requires a customer country outside Austria, and for an EU customer both UIDs.",
            },
          },
        },
      },
      required: ["invoiceId", "patch"],
    },
  },
  {
    name: "issue_invoice",
    annotation: "destructive",
    description:
      "Issue a draft invoice: allocates real number, renders the PDF, uploads to Storage, creates the linked TaxFile, and triggers the matching pipeline. Optionally creates a public share link.",
    inputSchema: {
      type: "object",
      properties: {
        invoiceId: { type: "string", description: "Invoice ID" },
        createShareLink: {
          type: "boolean",
          description: "If true, generate a public share token",
        },
      },
      required: ["invoiceId"],
    },
  },
  {
    name: "list_invoices",
    annotation: "read-only",
    description: "List invoices with optional filters",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["draft", "issued", "sent", "paid", "cancelled"],
          description: "Filter by status",
        },
        partnerId: { type: "string", description: "Filter by recipient partner" },
        fromDate: { type: "string", description: "Issue date >= (ISO)" },
        toDate: { type: "string", description: "Issue date <= (ISO)" },
        limit: { type: "number", description: "Max results (default 100, max 500)" },
      },
    },
  },
  {
    name: "get_invoice",
    annotation: "read-only",
    description: "Get a single invoice with downloadUrl and shareUrl if available",
    inputSchema: {
      type: "object",
      properties: { invoiceId: { type: "string", description: "Invoice ID" } },
      required: ["invoiceId"],
    },
  },
  {
    name: "duplicate_invoice",
    annotation: "write",
    description:
      "Duplicate an existing invoice as a new draft. Resets number, file link, share token, and lifecycle timestamps. issueDate becomes today.",
    inputSchema: {
      type: "object",
      properties: { invoiceId: { type: "string", description: "Source invoice ID" } },
      required: ["invoiceId"],
    },
  },
  {
    name: "cancel_invoice",
    annotation: "destructive",
    description:
      "Cancel an issued/sent/paid invoice (Storno). Issues an Invoice Correction (Rechnungskorrektur): a new invoice with its own next number, the original's line items negated, referencing the original. The original and its file stay on record with status 'cancelled'. Returns the correction's invoiceId, number and fileId. A correction itself cannot be cancelled; undo its issue (undo_issue_invoice), then discarding that draft in the app takes the Cancel back.",
    inputSchema: {
      type: "object",
      properties: { invoiceId: { type: "string", description: "Invoice ID" } },
      required: ["invoiceId"],
    },
  },
  {
    name: "undo_issue_invoice",
    annotation: "destructive",
    description:
      "Undo a misclicked issue: the invoice returns to an editable draft with the same number, and its generated PDF is destroyed. Allowed only while it is the newest invoice issued this year, was never sent, never paid and never opened through a share link. Anything else is refused with a pointer to cancel_invoice (Storno).",
    inputSchema: {
      type: "object",
      properties: { invoiceId: { type: "string", description: "Invoice ID" } },
      required: ["invoiceId"],
    },
  },

  // =========================================================================
  // Status
  // =========================================================================
  {
    name: "get_automation_status",
    annotation: "read-only",
    description: "Get user's automation mode, AI budget, and plan info",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_profile",
    annotation: "read-only",
    description:
      "A stable, opaque identifier for the signed-in FiBuKI user. Lets an assistant recognise the same person across " +
      "conversations without learning their email or user id. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
];

/** All valid tool names derived from definitions */
export type ToolName = (typeof TOOL_DEFINITIONS)[number]["name"];

/** Array of all tool names for validation */
export const TOOL_NAMES: string[] = TOOL_DEFINITIONS.map((t) => t.name);
