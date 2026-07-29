/**
 * Single source of truth for FLATTENED collections — Phase 1 of the
 * Firebase → Postgres rebuild (docs/rewrite-goals.md §Phase 1).
 *
 * A flattened collection moves out of the JSONB `docs` bridge table into its
 * own real table. The canonical document payload stays in a `data` JSONB
 * column (it is what round-trips through the Firestore shim, preserving
 * Firestore's absent-vs-null distinction that the parity suite pins); the
 * fields the app filters or orders on become STORED GENERATED columns over
 * that payload — real, indexable, joinable columns that can never skew from
 * the document because Postgres derives them on write.
 *
 * Both the Drizzle schema (schema.ts) and the shim's SQL pushdown
 * (pushdown.ts) are driven from this map, so a field added here shows up in
 * the next generated migration AND becomes pushdown-eligible with no second
 * edit.
 *
 * Phase 2 (rip the shim) turns the generated columns into plain columns and
 * drops `data`; at that point absent-vs-null stops mattering because the app
 * talks SQL, not Firestore.
 */

export type FlatKind = "text" | "boolean" | "number" | "timestamp";

export interface FlatField {
  /** SQL column name of the generated column. */
  col: string;
  kind: FlatKind;
}

export interface FlatSpec {
  /** SQL table name. */
  table: string;
  /**
   * Firestore field path (dot notation for nested maps) → generated column.
   * Only fields that appear in where()/orderBy() calls need to be here.
   */
  fields: Record<string, FlatField>;
  /** Column tuples to index beyond the (tenant_id, id) PK. */
  indexes: string[][];
}

/**
 * Timestamp wire format inside the JSONB payload (see firestore-shim.ts
 * TS_MARKER): { "__fbts__": { "s": seconds, "n": nanoseconds } }.
 */
const TS_MARKER = "__fbts__";

/** `data->'a'->'b'` selector for a dot-path. */
export function jsonNode(fieldPath: string): string {
  const segs = fieldPath.split(".");
  return `"data"` + segs.map((s) => `->'${s}'`).join("");
}

/**
 * SQL expression for a STORED GENERATED column projecting `fieldPath` out of
 * the `data` JSONB payload. Type-guarded with jsonb_typeof so a document
 * carrying an unexpected type yields NULL instead of failing the write.
 * Every function used (jsonb_typeof, ->, ->>, #>>, ?, to_timestamp(float8),
 * casts) is IMMUTABLE, which STORED generated columns require.
 */
export function generatedColumnExpr(fieldPath: string, kind: FlatKind): string {
  const node = jsonNode(fieldPath);
  const asText = `${node} #>> '{}'`;
  switch (kind) {
    case "text":
      return `CASE WHEN jsonb_typeof(${node}) = 'string' THEN ${asText} END`;
    case "boolean":
      return `CASE WHEN jsonb_typeof(${node}) = 'boolean' THEN (${asText})::boolean END`;
    case "number":
      return `CASE WHEN jsonb_typeof(${node}) = 'number' THEN (${asText})::double precision END`;
    case "timestamp":
      // Shim Timestamps are { __fbts__: { s, n } }. double precision keeps
      // ~0.2µs resolution at current epoch seconds — finer than the
      // microsecond precision of both timestamptz and real Firestore.
      return (
        `CASE WHEN ${node} ? '${TS_MARKER}' THEN ` +
        `to_timestamp((${node}->'${TS_MARKER}'->>'s')::double precision + ` +
        `(${node}->'${TS_MARKER}'->>'n')::double precision / 1e9) END`
      );
  }
}

/**
 * The flattened collections. Order of migration follows app call-site
 * weight (transactions 175 > files 125 > partners 92 > sources 53), but
 * `sources` goes first as the harness-proving collection: real query
 * traffic, simple shapes, no subcollections.
 *
 * Adding a collection here requires: (1) a table in schema.ts (mirrored from
 * this spec), (2) `npx drizzle-kit generate`, (3) appending the RLS
 * ENABLE/FORCE/POLICY block for the new table to the generated migration —
 * see drizzle/0000_*.sql for the pattern. The migration runner's backfill
 * step moves existing rows out of `docs` automatically.
 */
export const FLATTENED: Readonly<Record<string, FlatSpec>> = {
  sources: {
    table: "sources",
    fields: {
      // Query call sites: tools/handlers.ts, sources/*, banking/*,
      // matching/*, extraction/extractionCore.ts, user-export/*.
      userId: { col: "user_id", kind: "text" },
      isActive: { col: "is_active", kind: "boolean" },
      name: { col: "name", kind: "text" },
      linkedSourceId: { col: "linked_source_id", kind: "text" },
      "apiConfig.accountId": { col: "api_config_account_id", kind: "text" },
      // No current where()/orderBy() call site, but this exercises the
      // timestamp generated-column + pushdown path ahead of the collections
      // that need it (transactions/files order by dates constantly).
      createdAt: { col: "created_at", kind: "timestamp" },
    },
    indexes: [["tenant_id", "user_id"]],
  },
  transactions: {
    table: "transactions",
    fields: {
      // Query call sites (~175): tools/handlers.ts, transactions/*,
      // matching/*, banking/*, finapi/*, imports/*, sources/*, gmail/*,
      // precision-search/*, billing/clearQuotaExceeded.ts, digest/*,
      // emails/resolveMergeFields.ts, analytics/*, reconciliation/*,
      // workers/*, workflows/*, user-export/*.
      userId: { col: "user_id", kind: "text" },
      partnerId: { col: "partner_id", kind: "text" },
      sourceId: { col: "source_id", kind: "text" },
      noReceiptCategoryId: { col: "no_receipt_category_id", kind: "text" },
      importJobId: { col: "import_job_id", kind: "text" },
      // Bank-sync dedupe: `in` chunks of 30 plus `>= iban| AND < iban|~`
      // prefix ranges (banking/syncBankTransactions.ts, finapi/syncCallable.ts).
      dedupeHash: { col: "dedupe_hash", kind: "text" },
      partnerMatchedBy: { col: "partner_matched_by", kind: "text" },
      noReceiptCategoryMatchedBy: { col: "no_receipt_category_matched_by", kind: "text" },
      isComplete: { col: "is_complete", kind: "boolean" },
      quotaExceeded: { col: "quota_exceeded", kind: "boolean" },
      // The workhorse orderBy/range field (list views, balances, digests);
      // first real user of the timestamp keyset-cursor path.
      date: { col: "date", kind: "timestamp" },
      createdAt: { col: "created_at", kind: "timestamp" },
    },
    indexes: [
      ["tenant_id", "user_id", "date"],
      ["tenant_id", "user_id", "dedupe_hash"],
      ["tenant_id", "source_id"],
    ],
  },
  files: {
    table: "files",
    fields: {
      // Query call sites (~125): tools/handlers.ts, files/*, matching/*,
      // extraction/bulkRetryExtraction.ts, gmail/*, precision-search/*,
      // partners/deleteUserPartner.ts, digest/*, emails/resolveMergeFields.ts,
      // analytics/*, workflows/*, user-export/*. No array-contains anywhere;
      // enrichment batches use `__name__ in` (id, no column needed).
      userId: { col: "user_id", kind: "text" },
      // Also queried as `== null` (matching/onPartnerUpdate.ts re-match) —
      // null equality stays JS-side; the column serves the `== partnerId`
      // sites (matchFilesForPartner, deleteUserPartner, precision-search).
      partnerId: { col: "partner_id", kind: "text" },
      partnerMatchedBy: { col: "partner_matched_by", kind: "text" },
      // Content dedupe on upload/sync (gmail/gmailSyncQueue.ts,
      // precision-search/precisionSearchQueue.ts).
      contentHash: { col: "content_hash", kind: "text" },
      sourceType: { col: "source_type", kind: "text" },
      // Gmail attachment dedupe: (gmailMessageId, gmailAttachmentId) == pairs
      // and gmailMessageId `in` chunks (gmail/searchGmailCallable.ts).
      gmailMessageId: { col: "gmail_message_id", kind: "text" },
      gmailAttachmentId: { col: "gmail_attachment_id", kind: "text" },
      // Only queried as `!= null` (extraction/bulkRetryExtraction.ts), which
      // stays JS-side today — kept here so the spec is the complete queried-
      // field inventory and a future `!=` compiler needs no new migration.
      extractionError: { col: "extraction_error", kind: "text" },
      extractionComplete: { col: "extraction_complete", kind: "boolean" },
      partnerMatchComplete: { col: "partner_match_complete", kind: "boolean" },
      transactionMatchComplete: { col: "transaction_match_complete", kind: "boolean" },
      extractedDate: { col: "extracted_date", kind: "timestamp" },
      // listFiles workhorse orderBy (tools/handlers.ts:335).
      uploadedAt: { col: "uploaded_at", kind: "timestamp" },
      // Stale-scan: `< staleTime` + orderBy asc (matching/processOrphanedFiles.ts).
      updatedAt: { col: "updated_at", kind: "timestamp" },
      createdAt: { col: "created_at", kind: "timestamp" },
    },
    indexes: [
      ["tenant_id", "user_id", "uploaded_at"],
      ["tenant_id", "user_id", "content_hash"],
      ["tenant_id", "user_id", "gmail_message_id"],
      ["tenant_id", "partner_id"],
    ],
  },
  partners: {
    table: "partners",
    fields: {
      // Query call sites (~93): tools/handlers.ts, partners/*, matching/*,
      // admin/aggregateGlobalInsights.ts, admin/generatePromotionCandidates.ts,
      // browser/migrateInvoiceSources.ts, analytics/exportMatchIntelligence.ts,
      // user-export/*, user/*, user-import/*, auth/migrateUserData.ts. The
      // precision-search/invoicing partnerType ternaries and the
      // globalPartners queries beside these sites (partnerMatchingShared.ts,
      // aggregateGlobalInsights.ts, utils/globalPartnerUpsert.ts) are doc-by-id
      // or a DIFFERENT collection — not part of this surface. No
      // array-contains: aliases/ibans/emailDomains are only read from fetched
      // docs, never filtered on. `__name__` ==/in batches need no column.
      userId: { col: "user_id", kind: "text" },
      isActive: { col: "is_active", kind: "boolean" },
      // Admin aggregation (globalPartnerId == across users) and the
      // createLocalPartnerFromGlobal dedupe lookup.
      globalPartnerId: { col: "global_partner_id", kind: "text" },
      // listPartners workhorse orderBy asc (tools/handlers.ts:722).
      name: { col: "name", kind: "text" },
    },
    indexes: [
      ["tenant_id", "user_id"],
      ["tenant_id", "global_partner_id"],
    ],
  },
  fileConnections: {
    table: "file_connections",
    fields: {
      // The file↔transaction relation (one row per connection), flattened as
      // the enabler for the Phase-2 join deletions — see
      // docs/matching-engine-postgres-deletions.md case 8 (accepted
      // 2026-07-21). Query call sites (functions + frontend Admin-SDK
      // routes + agent tools): matching/matchFileTransactions.ts
      // (transactionId ==; fileId == + connectionType == + limit 1),
      // matching/learnBillingCycle.ts + learnScoringWeights.ts
      // (transactionId `in` chunks + userId ==),
      // analytics/exportMatchIntelligence.ts (userId == + orderBy createdAt
      // desc + limit), analytics/analyzeMatchAccuracy.ts (userId ==),
      // files/connect+disconnect+deleteFile.ts, sources/deleteSource.ts,
      // transactions/deleteTransactionsBySource.ts, tools/handlers.ts
      // (fileId == + transactionId ==), user/deleteUserAccountCallable.ts,
      // user-export/*, invoicing/onFileConnectionWrite.ts (trigger),
      // lib/agent/tools/batch-tools.ts + search-tools.ts,
      // lib/operations/file-ops.ts + file-transaction-matching-ops.ts,
      // components/partners/partner-detail-panel.tsx. No array fields, no
      // subcollections; every filtered/ordered field is below.
      fileId: { col: "file_id", kind: "text" },
      transactionId: { col: "transaction_id", kind: "text" },
      userId: { col: "user_id", kind: "text" },
      connectionType: { col: "connection_type", kind: "text" },
      createdAt: { col: "created_at", kind: "timestamp" },
    },
    indexes: [
      ["tenant_id", "transaction_id"],
      ["tenant_id", "file_id"],
      ["tenant_id", "user_id", "created_at"],
    ],
  },
};
