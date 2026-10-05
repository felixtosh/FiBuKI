/**
 * Apply a new column mapping to the Transactions of an earlier import.
 *
 * The browser parses the CSV rows with the user's new mapping (the parsers and the mapping UI live
 * there) and sends the parsed values; everything that must not drift lives here: the ownership
 * checks, the dedupe hash (imports/dedupe.ts, the one copy) and the write.
 *
 * The same call saves the new column mappings on the Import (#628): the browser never writes the
 * Imports table. The client sends its rows in chunks with the mappings on each; every chunk writes
 * the same values, so a repeated chunk changes nothing. Draft Imports keep their mappings through
 * updateDraftMappings, the import wizard's callable.
 */

import { Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { computeDedupeHash } from "./dedupe";

export interface RemapRow {
  transactionId: string;
  /** ISO 8601 */
  date: string;
  /** Integer cents. */
  amount: number;
  name: string;
  partner: string | null;
  reference: string | null;
  partnerIban: string | null;
  original: { date: string; amount: string; rawRow: Record<string, string> };
}

/** A column mapping as types/import.ts FieldMapping holds it. */
export interface RemapFieldMapping {
  csvColumn: string;
  targetField: string | null;
  confidence: number;
  userConfirmed: boolean;
  keepAsMetadata: boolean;
  format?: string;
}

interface ApplyImportRemapRequest {
  importJobId: string;
  sourceId: string;
  /** The mappings the rows were parsed with; saved on the Import. */
  fieldMappings: RemapFieldMapping[];
  rows: RemapRow[];
}

interface ApplyImportRemapResponse {
  success: boolean;
  updated: number;
  /** Rows whose Transaction is not this user's, or not from this import. */
  skipped: number;
}

const MAX_ROWS = 5000;
const CHUNK = 400;
const MAX_MAPPINGS = 500;
const MAPPING_FIELDS = new Set(["csvColumn", "targetField", "confidence", "userConfirmed", "keepAsMetadata", "format"]);

/** Refuses unknown fields and wrong types; returns only the fields a mapping holds. */
function validateMappings(input: unknown): RemapFieldMapping[] {
  if (!Array.isArray(input)) throw new HttpsError("invalid-argument", "fieldMappings is required");
  if (input.length > MAX_MAPPINGS) throw new HttpsError("invalid-argument", `Cannot save more than ${MAX_MAPPINGS} mappings`);
  return input.map((m: unknown, index) => {
    const fail = (what: string): never => {
      throw new HttpsError("invalid-argument", `fieldMappings[${index}]: ${what}`);
    };
    if (!m || typeof m !== "object" || Array.isArray(m)) return fail("must be an object");
    const mapping = m as Record<string, unknown>;
    const unknown = Object.keys(mapping).filter((key) => !MAPPING_FIELDS.has(key));
    if (unknown.length > 0) fail(`unknown field ${unknown.join(", ")}`);
    if (typeof mapping.csvColumn !== "string" || !mapping.csvColumn) fail("csvColumn is required");
    if (mapping.targetField !== null && typeof mapping.targetField !== "string") fail("targetField must be a string or null");
    if (typeof mapping.confidence !== "number" || !Number.isFinite(mapping.confidence)) fail("confidence must be a number");
    if (typeof mapping.userConfirmed !== "boolean") fail("userConfirmed must be a boolean");
    if (typeof mapping.keepAsMetadata !== "boolean") fail("keepAsMetadata must be a boolean");
    if (mapping.format !== undefined && mapping.format !== null && typeof mapping.format !== "string") fail("format must be a string");
    const clean: RemapFieldMapping = {
      csvColumn: mapping.csvColumn as string,
      targetField: mapping.targetField as string | null,
      confidence: mapping.confidence as number,
      userConfirmed: mapping.userConfirmed as boolean,
      keepAsMetadata: mapping.keepAsMetadata as boolean,
    };
    if (typeof mapping.format === "string") clean.format = mapping.format;
    return clean;
  });
}

function validateRow(row: RemapRow, index: number): void {
  const fail = (what: string) => {
    throw new HttpsError("invalid-argument", `rows[${index}]: ${what}`);
  };
  if (!row || typeof row !== "object") fail("must be an object");
  if (typeof row.transactionId !== "string" || !row.transactionId) fail("transactionId is required");
  if (typeof row.date !== "string" || isNaN(new Date(row.date).getTime())) fail("date must be an ISO date");
  if (!Number.isInteger(row.amount)) fail("amount must be an integer number of cents");
  if (typeof row.name !== "string") fail("name must be a string");
}

export const applyImportRemapCallable = createCallable<ApplyImportRemapRequest, ApplyImportRemapResponse>(
  { name: "applyImportRemap", timeoutSeconds: 300, memory: "512MiB" },
  async (ctx, request) => {
    const { importJobId, sourceId, rows } = request;
    if (!importJobId || typeof importJobId !== "string") throw new HttpsError("invalid-argument", "importJobId is required");
    if (!sourceId || typeof sourceId !== "string") throw new HttpsError("invalid-argument", "sourceId is required");
    if (!Array.isArray(rows)) throw new HttpsError("invalid-argument", "rows is required");
    if (rows.length > MAX_ROWS) throw new HttpsError("invalid-argument", `Cannot remap more than ${MAX_ROWS} rows at once`);
    rows.forEach(validateRow);
    const fieldMappings = validateMappings(request.fieldMappings);

    const sourceSnap = await ctx.db.collection("sources").doc(sourceId).get();
    if (!sourceSnap.exists) throw new HttpsError("not-found", "Source not found");
    const source = sourceSnap.data()!;
    if (source.userId !== ctx.userId) throw new HttpsError("permission-denied", "Source access denied");

    // Same identifier the import used: the IBAN, or the source id for accounts without one.
    const sourceIdentifier = (source.iban as string | undefined) || sourceId;
    const currency = (source.currency as string | undefined) ?? "EUR";

    const importRef = ctx.db.collection("imports").doc(importJobId);
    const importSnap = await importRef.get();
    if (!importSnap.exists) throw new HttpsError("not-found", "Import not found");
    const importRecord = importSnap.data()!;
    if (importRecord.userId !== ctx.userId) throw new HttpsError("permission-denied", "Import access denied");
    if (importRecord.sourceId !== sourceId) throw new HttpsError("invalid-argument", "Import is not from this bank account");
    if (importRecord.status === "draft") {
      throw new HttpsError("failed-precondition", "Cannot remap a draft import; the import wizard saves its mappings");
    }

    let updated = 0;
    let skipped = 0;

    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const refs = chunk.map((row) => ctx.db.collection("transactions").doc(row.transactionId));
      const snaps = await Promise.all(refs.map((ref) => ref.get()));

      const batch = ctx.db.batch();
      let inBatch = 0;
      chunk.forEach((row, index) => {
        const data = snaps[index].exists ? snaps[index].data()! : null;
        if (!data || data.userId !== ctx.userId || data.importJobId !== importJobId) {
          skipped += 1;
          return;
        }
        batch.update(refs[index], {
          date: Timestamp.fromDate(new Date(row.date)),
          amount: row.amount,
          currency,
          name: row.name,
          partner: row.partner ?? null,
          reference: row.reference ?? null,
          partnerIban: row.partnerIban ?? null,
          dedupeHash: computeDedupeHash({
            date: row.date,
            amount: row.amount,
            sourceIdentifier,
            reference: row.reference,
          }),
          _original: row.original,
          updatedAt: Timestamp.now(),
        });
        inBatch += 1;
      });

      if (inBatch > 0) await batch.commit();
      updated += inBatch;
    }

    await importRef.update({ fieldMappings, updatedAt: Timestamp.now() });

    return { success: true, updated, skipped };
  }
);
