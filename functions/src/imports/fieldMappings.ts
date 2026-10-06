/**
 * The one check on the column mappings a browser sends to be stored on an Import (#628).
 * createDraftImport, updateDraftMappings, createImportRecord and applyImportRemap all store
 * mappings through it, so a mapping holds only the fields a FieldMapping (types/import.ts) has,
 * and maps a column to one of the known import fields or to nothing.
 */

import { HttpsError } from "../utils/createCallable";
import { TRANSACTION_FIELDS } from "../import/columnFields";

/** A column mapping as types/import.ts FieldMapping holds it; the wizard stores an unset format as null. */
export interface StoredFieldMapping {
  csvColumn: string;
  targetField: string | null;
  confidence: number;
  userConfirmed: boolean;
  keepAsMetadata: boolean;
  format?: string | null;
}

/** The fields a column can map to: lib/import/field-definitions.ts, kept in sync by fieldMappings.sync.test.ts. */
export const IMPORT_TARGET_FIELDS: ReadonlySet<string> = new Set(TRANSACTION_FIELDS.map((f) => f.key));

const MAX_MAPPINGS = 500;
const MAPPING_FIELDS = new Set(["csvColumn", "targetField", "confidence", "userConfirmed", "keepAsMetadata", "format"]);

/**
 * Refuses a list that is not one, an unknown field, a wrong type and an unknown target field;
 * returns only the fields a mapping holds. A missing format stays missing, null stays null.
 */
export function validateFieldMappings(input: unknown): StoredFieldMapping[] {
  if (!Array.isArray(input)) throw new HttpsError("invalid-argument", "fieldMappings must be a list");
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
    if (mapping.targetField !== null && (typeof mapping.targetField !== "string" || !IMPORT_TARGET_FIELDS.has(mapping.targetField))) {
      fail("targetField must be a known import field or null");
    }
    if (typeof mapping.confidence !== "number" || !Number.isFinite(mapping.confidence)) fail("confidence must be a number");
    if (typeof mapping.userConfirmed !== "boolean") fail("userConfirmed must be a boolean");
    if (typeof mapping.keepAsMetadata !== "boolean") fail("keepAsMetadata must be a boolean");
    if (mapping.format !== undefined && mapping.format !== null && typeof mapping.format !== "string") fail("format must be a string or null");
    const clean: StoredFieldMapping = {
      csvColumn: mapping.csvColumn as string,
      targetField: mapping.targetField as string | null,
      confidence: mapping.confidence as number,
      userConfirmed: mapping.userConfirmed as boolean,
      keepAsMetadata: mapping.keepAsMetadata as boolean,
    };
    if (mapping.format !== undefined) clean.format = mapping.format as string | null;
    return clean;
  });
}
