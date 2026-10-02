import { onCall, HttpsError } from "firebase-functions/v2/https";
import { VertexAI } from "@google-cloud/vertexai";
import { logAIUsage } from "../utils/ai-usage-logger";
import { MODELS } from "../utils/models";
import {
  TRANSACTION_FIELDS,
  DATE_FORMATS,
  AMOUNT_FORMATS,
  MatchColumnsResponse,
} from "./columnFields";
import {
  columnMatchProvider,
  matchColumnsViaJev,
  typesafeAllowedFor,
} from "./matchColumnsJev";

// Re-export: matchInvestmentColumns.ts imports DATE_FORMATS from here (#304).
export { DATE_FORMATS };

const GEMINI_MODEL = MODELS.geminiLite;

// Get project ID from environment (Firebase sets this automatically)
function getProjectId(): string {
  const projectId =
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) {
    throw new Error("Could not determine Google Cloud project ID");
  }
  return projectId;
}

const VERTEX_LOCATION = process.env.VERTEX_LOCATION || "europe-west1";

interface MatchColumnsRequest {
  headers: string[];
  sampleRows: Record<string, string>[];
}

// ============================================================================
// Prompt Builder
// ============================================================================

function buildPrompt(
  headers: string[],
  sampleRows: Record<string, string>[]
): string {
  const fieldDescriptions = TRANSACTION_FIELDS.map(
    (f) =>
      `- **${f.key}** (${f.required ? "required" : "optional"}, type: ${f.type}): ${f.description}\n  Aliases: ${f.aliases.slice(0, 5).join(", ")}\n  Examples: ${f.examples.join(", ")}`
  ).join("\n\n");

  // Build column info with variance analysis
  const columnInfo = headers
    .map((header) => {
      const samples = sampleRows
        .slice(0, 10)
        .map((row) => row[header])
        .filter((v) => v && v.trim());
      const displaySamples = samples.slice(0, 3);
      const uniqueValues = new Set(samples);
      const isConstant = samples.length > 1 && uniqueValues.size === 1;

      let info = `Column: "${header}"\nSample values: ${displaySamples.length > 0 ? displaySamples.join(" | ") : "(empty)"}`;
      if (isConstant) {
        info += `\n⚠️ ALL VALUES IDENTICAL (likely account owner, not counterparty)`;
      }
      return info;
    })
    .join("\n\n");

  return `You are analyzing a CSV file containing bank transaction data for import into an Austrian/German accounting tool.

## Available Target Fields

${fieldDescriptions}

## CSV Columns to Match

${columnInfo}

## Instructions

For each CSV column, determine which target field it should map to.

CRITICAL RULES:
1. Each target field can ONLY be assigned to ONE column (no duplicates!)
2. If multiple columns could match a field, pick the BEST one and leave others as null
3. Required fields (date, amount, name) must be prioritized
4. "Total Amount" ALWAYS beats "Amount" - if both exist, map "Total Amount" to amount field

FIELD-SPECIFIC RULES (CONTENT MATTERS MORE THAN COLUMN NAME!):

**Reference/Transaction ID field (check this FIRST):**
- If a column named "ID" or similar contains UUIDs like "676f61e5-37a3-ae99-beb4-..." → map to "reference"
- Any column with unique identifiers (UUIDs, transaction IDs, alphanumeric codes) → "reference"
- This is the BEST field for deduplication

**Partner/Counterparty field (LOOK AT VALUES, NOT HEADER!):**
- If values look like company/merchant names → map to "partner", REGARDLESS of column name
- Company indicators: GmbH, AG, Inc., Ltd., S.a.r.l., Corp., LLC, names like "Amazon", "Netflix", "Billa", etc.
- EXAMPLE: Column "Description" with values "Arac Gmbh", "Billa Dankt", "OUSTER, INC." → map to "partner" (NOT "name")!
- If ALL values in column are identical, it's the account owner - do NOT map to partner

**Name/Description field (for booking text, NOT company names):**
- Use for verbose transaction details, payment references, invoice info
- EXAMPLE: Column "Reference" with values "/ROC/2024122400589///URI/Invoice R-..." → map to "name"
- Look for: SEPA references, invoice numbers, payment descriptions, booking text

**Amount field (CRITICAL PRIORITY!):**
- If BOTH "Total Amount"/"Total amount" AND "Amount" columns exist, you MUST map "Total Amount" to amount and leave "Amount" unmapped (null)
- "Total Amount" / "Gesamtbetrag" / "Total" ALWAYS wins over plain "Amount" / "Betrag"
- The total includes fees and is the actual bank movement amount
- NEVER map "Subtotal", "Net", "Fee", or "Amount" when "Total Amount" is available

CRITICAL: Analyze the ACTUAL SAMPLE VALUES to decide mappings. Column headers can be misleading!
- A "Description" column with company names → "partner"
- A "Reference" column with booking text → "name"
- An "ID" column with UUIDs → "reference"
- "Total Amount" column → "amount" (ignore plain "Amount" column if both exist)

## Amount Format Detection (IMPORTANT)

Analyze the sample values to determine the correct amount format:

- **"simple"**: Use when numbers have NO thousands separator, just a decimal point: 1234.56, 4480.00, -795.06
- **"us"**: Use when numbers HAVE comma as thousands separator: 1,234.56, 10,000.00
- **"de"**: Use when numbers use German format (dot for thousands, comma for decimal): 1.234,56
- **"simple-comma"**: Use when numbers have comma decimal but no thousands separator: 1234,56

CRITICAL: If numbers like "4480.00" or "-121.52" have NO comma/thousands separator, use "simple", NOT "us"!

Valid date format IDs: ${DATE_FORMATS.join(", ")}
Valid amount format IDs: ${AMOUNT_FORMATS.join(", ")}
Valid target field keys: ${TRANSACTION_FIELDS.map((f) => f.key).join(", ")}

Respond ONLY with valid JSON in this exact format (no markdown, no explanation):
{
  "mappings": [
    {"csvColumn": "column name", "targetField": "field key or null", "confidence": 0.0-1.0}
  ],
  "suggestedDateFormat": "format id or null",
  "suggestedAmountFormat": "format id or null",
  "suggestedBalanceFormat": "format id or null if balance field detected"
}`;
}

// ============================================================================
// Cloud Function
// ============================================================================

export const matchColumns = onCall<MatchColumnsRequest>(
  {
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (request): Promise<MatchColumnsResponse> => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }
    const userId = request.auth.uid;
    const { headers, sampleRows } = request.data;

    // Validate input
    if (!headers || !Array.isArray(headers) || headers.length === 0) {
      throw new HttpsError("invalid-argument", "headers array is required");
    }
    if (!sampleRows || !Array.isArray(sampleRows)) {
      throw new HttpsError("invalid-argument", "sampleRows array is required");
    }

    console.log(`Matching ${headers.length} columns with ${sampleRows.length} sample rows`);

    // Jev is opt-in per deployment (FIBUKI_COLUMN_MATCH_PROVIDER=typesafe). A
    // missing key is a config error and fails loudly; a runtime API failure
    // falls back to Gemini so a vendor outage cannot break imports.
    const email = typeof request.auth.token?.email === "string" ? request.auth.token.email : null;
    if (columnMatchProvider() === "typesafe" && typesafeAllowedFor(userId, email)) {
      try {
        const jev = await matchColumnsViaJev(headers, sampleRows);
        await logAIUsage(userId, {
          function: "columnMatching",
          model: jev.model,
          inputTokens: jev.inputTokens,
          outputTokens: jev.outputTokens,
        });
        const result = postProcessColumnResult(jev.result);
        console.log(
          `Successfully matched columns (typesafe):`,
          result.mappings.filter((m) => m.targetField).length
        );
        return result;
      } catch (error) {
        if (error instanceof Error && error.message.includes("FIBUKI_TYPESAFE_API_KEY")) {
          throw new HttpsError("failed-precondition", error.message);
        }
        console.error("typesafe column matching failed, falling back to Gemini:", error);
      }
    }

    try {
      const result = await matchViaGemini(userId, headers, sampleRows);
      console.log(`Successfully matched columns:`, result.mappings.filter((m) => m.targetField).length);
      return result;
    } catch (error) {
      if (error instanceof HttpsError) throw error;

      console.error("Error calling Gemini API:", error);
      throw new HttpsError(
        "internal",
        `AI matching failed: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
);

async function matchViaGemini(
  userId: string,
  headers: string[],
  sampleRows: Record<string, string>[]
): Promise<MatchColumnsResponse> {
  const projectId = getProjectId();
  const vertexAI = new VertexAI({ project: projectId, location: VERTEX_LOCATION });
  const model = vertexAI.getGenerativeModel({ model: GEMINI_MODEL });

  const prompt = buildPrompt(headers, sampleRows);

  const response = await model.generateContent({
    generationConfig: { responseMimeType: "application/json" },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  const responseData = response.response;

  // Log AI usage
  const usageMetadata = responseData.usageMetadata;
  await logAIUsage(userId, {
    function: "columnMatching",
    model: GEMINI_MODEL,
    inputTokens: usageMetadata?.promptTokenCount || 0,
    outputTokens: usageMetadata?.candidatesTokenCount || 0,
  });

  // Extract text from response
  const text = responseData.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new HttpsError("internal", "No text response from AI");
  }

  // Parse JSON response - handle markdown code blocks
  let jsonText = text.trim();
  if (jsonText.startsWith("```json")) {
    jsonText = jsonText.slice(7);
  } else if (jsonText.startsWith("```")) {
    jsonText = jsonText.slice(3);
  }
  if (jsonText.endsWith("```")) {
    jsonText = jsonText.slice(0, -3);
  }
  jsonText = jsonText.trim();
  let result: MatchColumnsResponse;

  try {
    result = JSON.parse(jsonText);
  } catch (parseError) {
    console.error("Failed to parse AI response:", jsonText);
    throw new HttpsError("internal", "Failed to parse AI response as JSON");
  }

  // Validate response structure
  if (!result.mappings || !Array.isArray(result.mappings)) {
    throw new HttpsError("internal", "Invalid response structure from AI");
  }

  return postProcessColumnResult(result);
}

/**
 * Shared post-processing for both backends: drop unknown field keys, clamp
 * confidence, enforce one column per target field (highest confidence wins),
 * and fall back to sane format defaults. Exported for tests.
 */
export function postProcessColumnResult(result: MatchColumnsResponse): MatchColumnsResponse {
  // Validate mappings
  const validFieldKeys = new Set(TRANSACTION_FIELDS.map((f) => f.key));
  result.mappings = result.mappings.map((m) => ({
    csvColumn: m.csvColumn,
    targetField: m.targetField && validFieldKeys.has(m.targetField) ? m.targetField : null,
    confidence: typeof m.confidence === "number" ? Math.min(1, Math.max(0, m.confidence)) : 0,
  }));

  // Deduplicate: each target field can only be used once (keep highest confidence)
  const usedFields = new Map<string, { csvColumn: string; confidence: number }>();
  for (const mapping of result.mappings) {
    if (!mapping.targetField) continue;

    const existing = usedFields.get(mapping.targetField);
    if (!existing || mapping.confidence > existing.confidence) {
      usedFields.set(mapping.targetField, {
        csvColumn: mapping.csvColumn,
        confidence: mapping.confidence,
      });
    }
  }

  // Apply deduplication - only the winning column keeps the field
  result.mappings = result.mappings.map((m) => {
    if (!m.targetField) return m;

    const winner = usedFields.get(m.targetField);
    if (winner && winner.csvColumn !== m.csvColumn) {
      // This column lost - remove the field assignment
      return { ...m, targetField: null, confidence: 0 };
    }
    return m;
  });

  // Validate format suggestions
  if (result.suggestedDateFormat && !DATE_FORMATS.includes(result.suggestedDateFormat)) {
    result.suggestedDateFormat = "de"; // Default to German
  }
  if (result.suggestedAmountFormat && !AMOUNT_FORMATS.includes(result.suggestedAmountFormat)) {
    result.suggestedAmountFormat = "de"; // Default to German
  }
  // For balance format, default to same as amount format if not specified
  if (!result.suggestedBalanceFormat) {
    result.suggestedBalanceFormat = result.suggestedAmountFormat;
  } else if (!AMOUNT_FORMATS.includes(result.suggestedBalanceFormat)) {
    result.suggestedBalanceFormat = result.suggestedAmountFormat || "de";
  }

  return result;
}
