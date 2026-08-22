/**
 * CSV parsing helpers for user data import.
 * Parses CSV content back into document objects.
 */

import { Timestamp } from "firebase-admin/firestore";

/**
 * Parse CSV content into array of objects
 */
export function parseCsv(content: string): Record<string, unknown>[] {
  const lines = content.split("\n").filter((line) => line.trim());
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]);
  const rows: Record<string, unknown>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row: Record<string, unknown> = {};

    for (let j = 0; j < headers.length; j++) {
      const header = headers[j];
      let value: unknown = values[j] || "";

      // Parse special types
      value = parseValue(value as string, header);

      // Handle nested keys (e.g., "_original_date" -> "_original.date")
      if (header.startsWith("_original_")) {
        const nestedKey = header.replace("_original_", "");
        if (!row._original) {
          row._original = {};
        }
        (row._original as Record<string, unknown>)[nestedKey] = value;
      } else {
        row[header] = value;
      }
    }

    rows.push(row);
  }

  return rows;
}

/**
 * Parse a single CSV line respecting quotes
 */
function parseCSVLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"' && !inQuotes) {
      inQuotes = true;
    } else if (char === '"' && inQuotes) {
      if (nextChar === '"') {
        // Escaped quote
        current += '"';
        i++;
      } else {
        // End of quoted string
        inQuotes = false;
      }
    } else if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

/**
 * Rebuild Firestore Timestamps nested inside a JSON-encoded column.
 *
 * `csvValue` only maps a *top-level* Timestamp to ISO; one sitting inside an
 * object is JSON-encoded as the admin SDK's private `{_seconds,_nanoseconds}`
 * shape. Left as a plain object it is not a Timestamp any more, so
 * `billingCycle.learned[].learnedAt` would read as "never learned" everywhere
 * downstream (`toIsoInstant` in the MCP handlers returns null for it).
 *
 * Duck-typed on exactly the two fields, as `dump-format.ts` does, so a
 * business object that merely carries a numeric `_seconds` is left alone.
 */
function reviveTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveTimestamps);
  if (value === null || typeof value !== "object") return value;

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (
    keys.length === 2 &&
    typeof obj._seconds === "number" &&
    typeof obj._nanoseconds === "number"
  ) {
    return new Timestamp(obj._seconds, obj._nanoseconds);
  }

  const revived: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(obj)) {
    revived[key] = reviveTimestamps(nested);
  }
  return revived;
}

/**
 * Parse a string value into its appropriate type
 */
function parseValue(value: string, header: string): unknown {
  if (value === "" || value === "null" || value === "undefined") {
    return null;
  }

  // Boolean fields
  if (value === "true") return true;
  if (value === "false") return false;

  // Timestamp fields (ISO 8601 dates)
  if (
    header.endsWith("At") ||
    header === "date" ||
    header === "createdAt" ||
    header === "updatedAt"
  ) {
    const date = new Date(value);
    if (!isNaN(date.getTime())) {
      return Timestamp.fromDate(date);
    }
  }

  // Numeric fields
  if (
    header === "amount" ||
    header === "vatAmount" ||
    header === "fileSize" ||
    header === "sortOrder" ||
    header.endsWith("Confidence") ||
    header === "csvRowIndex" ||
    header === "transactionCount"
  ) {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      return num;
    }
  }

  // JSON fields (arrays and objects)
  if (
    value.startsWith("[") ||
    value.startsWith("{") ||
    header === "fieldMappings" ||
    header === "aliases" ||
    header === "ibans" ||
    header === "fileIds" ||
    header === "rejectedFileIds" ||
    header === "transactionIds" ||
    header === "matchedPartnerIds" ||
    header === "learnedPatterns" ||
    header === "fileSourcePatterns" ||
    header === "manualRemovals" ||
    header === "emailDomains" ||
    header === "billingCycle" ||
    header === "matchSources" ||
    header === "extractedIssuer" ||
    header === "extractedRecipient" ||
    header === "resolutionPreference" ||
    header === "_original_rawRow"
  ) {
    try {
      const parsed = JSON.parse(value);
      // Only billingCycle: the older JSON columns have always imported their
      // nested Timestamps as plain objects, and changing that is its own job.
      return header === "billingCycle" ? reviveTimestamps(parsed) : parsed;
    } catch {
      return value;
    }
  }

  return value;
}

/**
 * Sanitize a document ID (replace invalid characters)
 */
export function sanitizeDocId(id: string): string {
  // Firestore doc IDs can't contain: /, ., .., __.*__
  return id.replace(/[/]/g, "_").replace(/\.\./g, "__");
}

/**
 * Prepare a document for import (remove computed/system fields)
 */
export function prepareDocForImport(
  doc: Record<string, unknown>,
  userId: string
): Record<string, unknown> {
  const prepared = { ...doc };

  // Always set userId
  prepared.userId = userId;

  // Remove id (will be set as document ID)
  delete prepared.id;

  return prepared;
}
