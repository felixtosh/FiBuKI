/**
 * API twins (#685): the pure half of the one-off repair.
 *
 * Before the server-side duplicate check (fd15effa), MCP `import_transactions`
 * stored rows under an `api_<13 digits>` import id with its own dedupe hash
 * and no bank reference, so a later CSV import of the same Bank Account did
 * not recognise them and stored every bank line again. The CSV row is the
 * one to keep: it holds the raw bank row and the canonical hash.
 *
 * A pair is one API row and one CSV row of the same Bank Account, day and
 * amount, matched one to one. Card lines name the merchant's order reference,
 * so such a pair is one bank line, never two real payments. Where a day and
 * amount hold several rows on either side, the normalised name decides; what
 * it does not settle is reported, never guessed.
 *
 * This module reads nothing and writes nothing. `pairTwins` pairs rows,
 * `planTwinMerge` decides what one pair's merge does; the apply
 * (repairApiTwins.ts) carries a plan out through the writers.
 */

import { isLiveCopy } from "../files/copyOps";
import { isTransactionDismissed } from "../matching/dismissedTransactions";
import { isFileRejected } from "../matching/rejectedFiles";
import { ORIGIN_RULES, isConnectionOrigin, type ConnectionOrigin } from "../fileConnections/rules";
import type { FileConnectionSourceInfo } from "../fileConnections/learning";

// ============================================================================
// Pairing
// ============================================================================

export type ImportKind = "legacy-api" | "csv" | "other";

/** The MCP tool's import id before it gained a random suffix and the duplicate check. */
export const LEGACY_API_IMPORT = /^api_\d{13}$/;

/** Import ids that are neither a CSV import nor the old MCP one: bank syncs and the current tool. */
const NOT_CSV_PREFIXES = ["api_", "sync_", "finapi_", "truelayer_"];

export function importKind(importJobId: string | null | undefined): ImportKind {
  if (typeof importJobId !== "string" || !importJobId) return "other";
  if (LEGACY_API_IMPORT.test(importJobId)) return "legacy-api";
  if (NOT_CSV_PREFIXES.some((p) => importJobId.startsWith(p))) return "other";
  return "csv";
}

/** One Transaction of a Bank Account, as pairing sees it. */
export interface TwinRow {
  id: string;
  importJobId: string | null;
  /** The Vienna calendar day, `YYYY-MM-DD`. */
  day: string;
  /** Integer cents. */
  amount: number;
  name: string;
}

export interface Pairing {
  pairs: Array<{ apiId: string; csvId: string }>;
  /** API rows with no CSV row of the same day and amount. */
  unmatched: string[];
  /** Day-and-amount groups the name does not pair one to one. */
  ambiguous: Array<{ apiIds: string[]; csvIds: string[] }>;
}

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Pair the legacy API rows of one Bank Account with its CSV rows. */
export function pairTwins(rows: TwinRow[]): Pairing {
  const groups = new Map<string, { api: TwinRow[]; csv: TwinRow[] }>();
  for (const r of rows) {
    const kind = importKind(r.importJobId);
    if (kind === "other") continue;
    const key = `${r.day}|${r.amount}`;
    if (!groups.has(key)) groups.set(key, { api: [], csv: [] });
    groups.get(key)![kind === "legacy-api" ? "api" : "csv"].push(r);
  }

  const result: Pairing = { pairs: [], unmatched: [], ambiguous: [] };
  for (const { api, csv } of groups.values()) {
    if (api.length === 0) continue;
    if (csv.length === 0) {
      result.unmatched.push(...api.map((r) => r.id));
      continue;
    }
    if (api.length === 1 && csv.length === 1) {
      result.pairs.push({ apiId: api[0].id, csvId: csv[0].id });
      continue;
    }
    // Several on a side: a pair by name only where the name is unique on both sides.
    const count = (list: TwinRow[], name: string) => list.filter((r) => normalizeName(r.name) === name).length;
    const leftApi: TwinRow[] = [];
    const usedCsv = new Set<string>();
    for (const a of api) {
      const name = normalizeName(a.name);
      const match = csv.find((c) => normalizeName(c.name) === name);
      if (match && count(api, name) === 1 && count(csv, name) === 1) {
        result.pairs.push({ apiId: a.id, csvId: match.id });
        usedCsv.add(match.id);
      } else {
        leftApi.push(a);
      }
    }
    if (leftApi.length > 0) {
      result.ambiguous.push({
        apiIds: leftApi.map((r) => r.id),
        csvIds: csv.filter((c) => !usedCsv.has(c.id)).map((r) => r.id),
      });
    }
  }
  return result;
}

// ============================================================================
// The merge plan of one pair
// ============================================================================

type Data = Record<string, unknown>;
interface Doc {
  id: string;
  data: Data;
}

export interface PlanInput {
  api: Doc;
  csv: Doc;
  /** The File Connection records of both twins. */
  records: Doc[];
  /** Every File either twin lists. */
  files: Map<string, Data>;
  /** The originals those Files name as Copies of (`copyOfFileId`). */
  originals: Map<string, Data>;
}

/** One File Connection to move from the API twin onto the CSV row, as the record holds it. */
export interface FileMove {
  fileId: string;
  origin: ConnectionOrigin;
  connectionType?: string;
  matchConfidence?: number;
  matchSources?: unknown;
  scoreBreakdown?: unknown;
  autoConnectReason?: "remainder_same_day" | "paired" | "instalment";
  aiReasoning?: string;
  sourceInfo?: FileConnectionSourceInfo;
}

export type PartnerMatchedBy = "manual" | "suggestion" | "auto" | "ai" | "api";
export type CategoryMatchedBy = "manual" | "suggestion" | "auto";

/**
 * What the removal of the API twin does to the month's Transaction count.
 * `decrement`: both twins were counted, the line once too often. `transfer`:
 * only the API twin was counted, so the CSV row takes its slot (its
 * `quotaExceeded` is cleared). `none`: the API twin was never counted.
 */
export type QuotaStep = "decrement" | "transfer" | "none";

export type MergePlan =
  | {
      kind: "merge";
      apiId: string;
      csvId: string;
      /** Files only the API twin holds: connected to the CSV row, then unlinked from the API twin. */
      moves: FileMove[];
      /** Files both twins hold: only unlinked from the API twin. */
      unlinkOnly: string[];
      partner: { partnerId: string; partnerType: "global" | "user"; matchedBy: PartnerMatchedBy; confidence?: number } | null;
      category: { categoryId: string; matchedBy: CategoryMatchedBy; confidence: number | null } | null;
      quota: QuotaStep;
      /** `api-complete-without-evidence`: the API twin is marked complete with no File and no Category; nothing moves it. */
      notes: string[];
    }
  | {
      kind: "decision";
      apiId: string;
      csvId: string;
      reason: "different-files" | "different-partners" | "different-categories" | "rejected-on-csv";
      apiFileIds?: string[];
      csvFileIds?: string[];
      fileId?: string;
    }
  | {
      kind: "blocked";
      apiId: string;
      csvId: string;
      /** A move the File Connection writer would refuse, or cannot be made faithfully. */
      reason: "deleted" | "copy" | "no-record" | "unknown-origin" | "over-quota";
      fileId: string;
    };

/** The origin of a record written before #612 stored one, by the label each writer used. */
const ORIGIN_BY_LABEL: Record<string, ConnectionOrigin> = {
  manual: "manual",
  gmail_import: "manual",
  gmail_html_conversion: "manual",
  suggestion_accepted: "suggestion",
  api: "mcp",
  auto_matched: "auto",
  ai_matched: "ai",
};

const SOURCE_INFO_FIELDS: ReadonlyArray<keyof FileConnectionSourceInfo> = [
  "sourceType",
  "searchPattern",
  "gmailIntegrationId",
  "gmailIntegrationEmail",
  "mailMessageId",
  "gmailMessageFrom",
  "gmailMessageFromName",
  "resultType",
];

const AUTO_CONNECT_REASONS = new Set(["remainder_same_day", "paired", "instalment"]);
const PARTNER_MATCHED_BY = new Set(["manual", "suggestion", "auto", "ai", "api"]);
const CATEGORY_MATCHED_BY = new Set(["manual", "suggestion", "auto"]);

export function recordOrigin(record: Data): ConnectionOrigin | null {
  if (isConnectionOrigin(record.origin)) return record.origin;
  return typeof record.connectionType === "string" ? ORIGIN_BY_LABEL[record.connectionType] ?? null : null;
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && !!v) : [];
}

function millis(value: unknown): number {
  const v = value as { toMillis?: () => number } | undefined;
  return typeof v?.toMillis === "function" ? v.toMillis() : Number.POSITIVE_INFINITY;
}

/** The record a pair written twice before #612 counts by: its earliest. */
function earliest(records: Doc[]): Doc | undefined {
  return [...records].sort((a, b) => millis(a.data.createdAt) - millis(b.data.createdAt))[0];
}

function fileIdsOf(tx: Doc, records: Doc[]): string[] {
  const out = new Set(ids(tx.data.fileIds));
  for (const r of records) if (r.data.transactionId === tx.id && typeof r.data.fileId === "string") out.add(r.data.fileId);
  return [...out];
}

function moveOf(fileId: string, origin: ConnectionOrigin, record: Data): FileMove {
  const move: FileMove = { fileId, origin };
  if (typeof record.connectionType === "string" && record.connectionType) move.connectionType = record.connectionType;
  if (typeof record.matchConfidence === "number") move.matchConfidence = record.matchConfidence;
  if (record.matchSources != null) move.matchSources = record.matchSources;
  if (record.scoreBreakdown != null) move.scoreBreakdown = record.scoreBreakdown;
  if (typeof record.autoConnectReason === "string" && AUTO_CONNECT_REASONS.has(record.autoConnectReason)) {
    move.autoConnectReason = record.autoConnectReason as FileMove["autoConnectReason"];
  }
  if (typeof record.aiReasoning === "string" && record.aiReasoning) move.aiReasoning = record.aiReasoning;
  const sourceInfo: FileConnectionSourceInfo = {};
  for (const key of SOURCE_INFO_FIELDS) {
    const value = record[key];
    if (typeof value === "string" && value) (sourceInfo as Record<string, string>)[key] = value;
  }
  if (Object.keys(sourceInfo).length > 0) move.sourceInfo = sourceInfo;
  return move;
}

/**
 * What merging one pair does, decided from the two rows, their File
 * Connection records and the Files they list. The CSV row is kept.
 *
 * - Each twin holding a File the other does not: the User decides (#685
 *   open question 1, often a Copy of one receipt; marking it a Copy removes
 *   its Connection and the next run moves the rest).
 * - Different Partners or No-document Categories on the twins, or a File the
 *   CSV row rejected: the User decides too.
 * - A move the writer would refuse (a Copy, a deleted File, both twins over
 *   quota) or cannot make faithfully (a listing with no record, a record of no
 *   known origin) blocks the pair; it is reported, not forced.
 */
export function planTwinMerge(input: PlanInput): MergePlan {
  const { api, csv, records, files, originals } = input;
  const head = { apiId: api.id, csvId: csv.id };
  const apiFiles = fileIdsOf(api, records);
  const csvFiles = fileIdsOf(csv, records);
  const apiOnly = apiFiles.filter((id) => !csvFiles.includes(id));
  const csvOnly = csvFiles.filter((id) => !apiFiles.includes(id));

  if (apiOnly.length > 0 && csvOnly.length > 0) {
    return { kind: "decision", ...head, reason: "different-files", apiFileIds: apiOnly, csvFileIds: csvOnly };
  }
  const apiPartner = typeof api.data.partnerId === "string" && api.data.partnerId ? api.data.partnerId : null;
  const csvPartner = typeof csv.data.partnerId === "string" && csv.data.partnerId ? csv.data.partnerId : null;
  if (apiPartner && csvPartner && apiPartner !== csvPartner) {
    return { kind: "decision", ...head, reason: "different-partners" };
  }
  const apiCategory =
    typeof api.data.noReceiptCategoryId === "string" && api.data.noReceiptCategoryId ? api.data.noReceiptCategoryId : null;
  const csvCategory =
    typeof csv.data.noReceiptCategoryId === "string" && csv.data.noReceiptCategoryId ? csv.data.noReceiptCategoryId : null;
  if (apiCategory && csvCategory && apiCategory !== csvCategory) {
    return { kind: "decision", ...head, reason: "different-categories" };
  }

  const quota: QuotaStep = api.data.quotaExceeded ? "none" : csv.data.quotaExceeded ? "transfer" : "decrement";
  const csvOverQuota = csv.data.quotaExceeded === true && quota !== "transfer";

  const moves: FileMove[] = [];
  for (const fileId of apiOnly) {
    const file = files.get(fileId);
    if (!file || file.deletedAt || file.purgedAt) return { kind: "blocked", ...head, reason: "deleted", fileId };
    const originalId = file.copyOfFileId;
    if (typeof originalId === "string" && originalId && isLiveCopy(file, originals.get(originalId))) {
      return { kind: "blocked", ...head, reason: "copy", fileId };
    }
    const record = earliest(records.filter((r) => r.data.fileId === fileId && r.data.transactionId === api.id));
    if (!record) return { kind: "blocked", ...head, reason: "no-record", fileId };
    const origin = recordOrigin(record.data);
    if (!origin) return { kind: "blocked", ...head, reason: "unknown-origin", fileId };
    if (isFileRejected(csv.data, fileId) || isTransactionDismissed(file, csv.id)) {
      return { kind: "decision", ...head, reason: "rejected-on-csv", fileId };
    }
    if (csvOverQuota && !ORIGIN_RULES[origin].overQuota) return { kind: "blocked", ...head, reason: "over-quota", fileId };
    moves.push(moveOf(fileId, origin, record.data));
  }

  const partner =
    apiPartner && !csvPartner
      ? {
          partnerId: apiPartner,
          partnerType: (api.data.partnerType === "global" ? "global" : "user") as "global" | "user",
          matchedBy: (PARTNER_MATCHED_BY.has(api.data.partnerMatchedBy as string)
            ? api.data.partnerMatchedBy
            : "api") as PartnerMatchedBy,
          ...(typeof api.data.partnerMatchConfidence === "number" ? { confidence: api.data.partnerMatchConfidence } : {}),
        }
      : null;
  const category =
    apiCategory && !csvCategory
      ? {
          categoryId: apiCategory,
          matchedBy: (CATEGORY_MATCHED_BY.has(api.data.noReceiptCategoryMatchedBy as string)
            ? api.data.noReceiptCategoryMatchedBy
            : "manual") as CategoryMatchedBy,
          confidence: typeof api.data.noReceiptCategoryConfidence === "number" ? api.data.noReceiptCategoryConfidence : null,
        }
      : null;
  const notes: string[] = [];
  if (api.data.isComplete === true && apiFiles.length === 0 && !apiCategory) notes.push("api-complete-without-evidence");

  return {
    kind: "merge",
    ...head,
    moves,
    unlinkOnly: apiFiles.filter((id) => csvFiles.includes(id)),
    partner,
    category,
    quota,
    notes,
  };
}
