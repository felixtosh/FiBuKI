import { FieldMapping, ColumnMatchResult } from "@/types/import";
import {
  TRANSACTION_FIELDS,
  findFieldByAlias,
  buildFieldDescriptionsForAI,
} from "./field-definitions";
import { detectDateFormat } from "./date-parsers";
import { detectAmountFormat } from "./amount-parsers";
import { getColumnSamples } from "./csv-parser";
import { matchColumnsWithAI } from "./ai-matcher";

/**
 * Auto-match CSV columns to transaction fields using Claude AI.
 * This is the primary matching method.
 */
export async function autoMatchColumns(
  headers: string[],
  sampleRows: Record<string, string>[]
): Promise<FieldMapping[]> {
  return matchColumnsWithAI(headers, sampleRows);
}

/**
 * Rule-based column matching (fallback/testing).
 * Uses a multi-step approach:
 * 1. Exact alias matching
 * 2. Fuzzy alias matching
 * 3. Pattern detection (dates, amounts)
 */
export async function autoMatchColumnsRuleBased(
  headers: string[],
  sampleRows: Record<string, string>[]
): Promise<FieldMapping[]> {
  const mappings: FieldMapping[] = [];
  const usedFields = new Set<string>();

  for (const header of headers) {
    const samples = getColumnSamples(sampleRows, header);
    const result = matchColumn(header, samples, usedFields);

    mappings.push({
      csvColumn: header,
      targetField: result.matchedField,
      confidence: result.confidence,
      userConfirmed: false,
      keepAsMetadata: result.matchedField === null,
      format: result.suggestedParser, // Include detected format
    });

    if (result.matchedField) {
      usedFields.add(result.matchedField);
    }
  }

  return mappings;
}

/**
 * Match a single column to a transaction field
 */
function matchColumn(
  header: string,
  samples: string[],
  usedFields: Set<string>
): ColumnMatchResult {
  // Step 1: Try exact alias match
  const aliasMatch = findFieldByAlias(header);
  if (aliasMatch && !usedFields.has(aliasMatch.key)) {
    return {
      csvColumn: header,
      matchedField: aliasMatch.key,
      confidence: 1.0,
      suggestedParser: detectParserForField(aliasMatch.key, samples),
    };
  }

  // Step 2: Try fuzzy alias match
  const fuzzyMatch = fuzzyMatchAlias(header, usedFields);
  if (fuzzyMatch) {
    return {
      csvColumn: header,
      matchedField: fuzzyMatch.key,
      confidence: fuzzyMatch.confidence,
      suggestedParser: detectParserForField(fuzzyMatch.key, samples),
    };
  }

  // Step 3: Try pattern detection
  const patternMatch = detectFieldByPattern(samples, usedFields);
  if (patternMatch) {
    return {
      csvColumn: header,
      matchedField: patternMatch.key,
      confidence: patternMatch.confidence,
      suggestedParser: patternMatch.suggestedParser,
    };
  }

  // No match found
  return {
    csvColumn: header,
    matchedField: null,
    confidence: 0,
  };
}

/**
 * Fuzzy match header against field aliases using Levenshtein distance
 */
function fuzzyMatchAlias(
  header: string,
  usedFields: Set<string>
): { key: string; confidence: number } | null {
  const normalizedHeader = header.toLowerCase().trim();
  let bestMatch: { key: string; confidence: number } | null = null;

  for (const field of TRANSACTION_FIELDS) {
    if (usedFields.has(field.key)) continue;

    for (const alias of field.aliases) {
      const normalizedAlias = alias.toLowerCase();
      const distance = levenshteinDistance(normalizedHeader, normalizedAlias);
      const maxLen = Math.max(normalizedHeader.length, normalizedAlias.length);
      const similarity = 1 - distance / maxLen;

      // Require at least 70% similarity
      if (similarity >= 0.7) {
        if (!bestMatch || similarity > bestMatch.confidence) {
          bestMatch = { key: field.key, confidence: similarity };
        }
      }
    }
  }

  return bestMatch;
}

/**
 * Detect field type by analyzing sample values
 */
function detectFieldByPattern(
  samples: string[],
  usedFields: Set<string>
): { key: string; confidence: number; suggestedParser?: string } | null {
  if (samples.length === 0) return null;

  // Check for date patterns
  if (!usedFields.has("date")) {
    const dateFormat = detectDateFormat(samples);
    if (dateFormat) {
      return {
        key: "date",
        confidence: 0.8,
        suggestedParser: dateFormat,
      };
    }
  }

  // Check for amount patterns
  if (!usedFields.has("amount")) {
    const amountFormat = detectAmountFormat(samples);
    if (amountFormat && looksLikeAmount(samples)) {
      return {
        key: "amount",
        confidence: 0.75,
        suggestedParser: amountFormat,
      };
    }
  }

  // Check for IBAN patterns
  if (!usedFields.has("partnerIban")) {
    if (looksLikeIban(samples)) {
      return {
        key: "partnerIban",
        confidence: 0.9,
      };
    }
  }

  return null;
}

/**
 * Check if samples look like monetary amounts
 */
function looksLikeAmount(samples: string[]): boolean {
  let numericCount = 0;

  for (const sample of samples) {
    // Remove currency symbols and check if mostly numeric
    const cleaned = sample.replace(/[€$£¥₹CHF\s]/gi, "");
    if (/^[\d.,()-]+$/.test(cleaned)) {
      numericCount++;
    }
  }

  return numericCount >= samples.length * 0.7;
}

/**
 * Check if samples look like IBANs
 */
function looksLikeIban(samples: string[]): boolean {
  let ibanCount = 0;

  for (const sample of samples) {
    const cleaned = sample.replace(/\s/g, "");
    if (/^[A-Z]{2}\d{2}[A-Z0-9]{11,28}$/i.test(cleaned)) {
      ibanCount++;
    }
  }

  return ibanCount >= samples.length * 0.5;
}

/**
 * Detect the appropriate parser for a field type
 */
function detectParserForField(
  fieldKey: string,
  samples: string[]
): string | undefined {
  if (fieldKey === "date") {
    return detectDateFormat(samples) ?? undefined;
  }
  if (fieldKey === "amount") {
    return detectAmountFormat(samples) ?? undefined;
  }
  return undefined;
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Build the prompt for AI-based column matching
 * (For future use with Claude API)
 */
export function buildAIMatchingPrompt(
  headers: string[],
  sampleRows: Record<string, string>[]
): string {
  const fieldDescriptions = buildFieldDescriptionsForAI();

  const columnInfo = headers
    .map((header) => {
      const samples = getColumnSamples(sampleRows, header, 10);
      return `Column: "${header}"\nSample values: ${samples.join(", ")}`;
    })
    .join("\n\n");

  return `You are analyzing a CSV file containing bank transaction data for import.

## Available Target Fields

${fieldDescriptions}

## CSV Columns to Match

${columnInfo}

## Instructions

For each CSV column, determine which target field it should map to.
Consider:
1. The column header name (may be in German or English)
2. The format and content of sample values
3. Each target field can only be used once

Respond in JSON format:
{
  "mappings": [
    {
      "csvColumn": "column name",
      "targetField": "field key or null",
      "confidence": 0.0-1.0,
      "reasoning": "brief explanation"
    }
  ],
  "suggestedDateFormat": "parser id for date column",
  "suggestedAmountFormat": "parser id for amount column"
}`;
}

/**
 * Validate that all required fields are mapped.
 * Hard-requires: date + amount.
 * Soft-requires: at least one of name OR partner must be mapped.
 */
export function validateMappings(mappings: FieldMapping[]): {
  isValid: boolean;
  missingFields: string[];
} {
  const mappedFields = new Set(
    mappings.filter((m) => m.targetField).map((m) => m.targetField)
  );

  const missingFields: string[] = [];

  // Hard-required: date and amount
  if (!mappedFields.has("date")) missingFields.push("date");
  if (!mappedFields.has("amount")) missingFields.push("amount");

  // Soft-required: name OR partner (at least one)
  const hasNameOrPartner = mappedFields.has("name") || mappedFields.has("partner");
  if (!hasNameOrPartner) {
    missingFields.push("description or partner");
  }

  return {
    isValid: missingFields.length === 0,
    missingFields,
  };
}
