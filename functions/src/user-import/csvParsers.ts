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
    header === "matchSources" ||
    header === "extractedIssuer" ||
    header === "extractedRecipient" ||
    header === "resolutionPreference" ||
    header === "_original_rawRow"
  ) {
    try {
      return JSON.parse(value);
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
