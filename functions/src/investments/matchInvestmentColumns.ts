import { onCall, HttpsError } from "firebase-functions/v2/https";
import { VertexAI } from "@google-cloud/vertexai";
import { logAIUsage } from "../utils/ai-usage-logger";
import { MODELS } from "../utils/models";
import { DATE_FORMATS } from "../import/matchColumns";

const GEMINI_MODEL = MODELS.geminiLite;

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

// ============================================================================
// Types
// ============================================================================

interface MatchInvestmentColumnsRequest {
  headers: string[];
  sampleRows: Record<string, string>[];
}

interface ColumnMapping {
  csvColumn: string;
  targetField: string | null;
  confidence: number;
}

interface MatchInvestmentColumnsResponse {
  mappings: ColumnMapping[];
  suggestedDateFormat: string | null;
  suggestedAmountFormat: string | null;
}

// ============================================================================
// Investment Field Definitions
// ============================================================================

interface FieldDefinition {
  key: string;
  label: string;
  description: string;
  aliases: string[];
  required: boolean;
  type: "date" | "amount" | "text" | "iban";
  examples: string[];
}

const INVESTMENT_FIELDS: FieldDefinition[] = [
  {
    key: "date",
    label: "Trade Date",
    description: "The date when the trade was executed.",
    aliases: [
      "Datum", "Ausführungsdatum", "Handelsdatum", "Buchungsdatum",
      "Date", "Trade Date", "Execution Date", "Settlement Date",
    ],
    required: true,
    type: "date",
    examples: ["15.03.2024", "2024-03-15", "03/15/2024"],
  },
  {
    key: "tradeType",
    label: "Trade Type",
    description: "The type of trade: buy, sell, dividend, interest, fee, or transfer.",
    aliases: [
      "Typ", "Art", "Aktion", "Transaktionsart",
      "Type", "Trade Type", "Action", "Side", "Direction",
    ],
    required: true,
    type: "text",
    examples: ["Buy", "Sell", "Dividend", "Kauf", "Verkauf", "Open Position", "Close Position"],
  },
  {
    key: "ticker",
    label: "Ticker / Symbol",
    description: "The ticker symbol or identifier of the traded asset.",
    aliases: [
      "Symbol", "Kürzel", "Instrument", "Wertpapier", "Coin",
      "Ticker", "Asset", "Market", "Pair",
    ],
    required: true,
    type: "text",
    examples: ["AAPL", "BTC", "VWCE.DE", "TSLA"],
  },
  {
    key: "isin",
    label: "ISIN",
    description: "International Securities Identification Number (12-char alphanumeric).",
    aliases: ["ISIN", "WKN", "Security ID", "Wertpapierkennnummer"],
    required: false,
    type: "text",
    examples: ["US0378331005", "IE00B4L5Y983"],
  },
  {
    key: "assetName",
    label: "Asset Name",
    description: "Human-readable name of the asset.",
    aliases: [
      "Name", "Wertpapier", "Bezeichnung", "Beschreibung",
      "Asset Name", "Security", "Description", "Details",
    ],
    required: false,
    type: "text",
    examples: ["Apple Inc.", "Bitcoin", "Vanguard FTSE All-World"],
  },
  {
    key: "quantity",
    label: "Quantity",
    description: "Number of units traded. Can be fractional for crypto.",
    aliases: [
      "Stück", "Anzahl", "Menge", "Einheiten",
      "Quantity", "Qty", "Units", "Shares", "Size",
    ],
    required: true,
    type: "amount",
    examples: ["10", "0.5", "100", "0.00125"],
  },
  {
    key: "pricePerUnit",
    label: "Price per Unit",
    description: "Price per unit/share at execution.",
    aliases: [
      "Kurs", "Preis", "Ausführungskurs", "Rate",
      "Price", "Price per Unit", "Fill Price", "Unit Price",
    ],
    required: false,
    type: "amount",
    examples: ["150.25", "42,350.00", "0.0012"],
  },
  {
    key: "grossAmount",
    label: "Total Amount",
    description: "Total trade value (quantity * price), before fees.",
    aliases: [
      "Betrag", "Gesamtbetrag", "Volumen", "Wert", "Summe",
      "Total", "Amount", "Value", "Gross Amount", "Trade Value",
    ],
    required: true,
    type: "amount",
    examples: ["-1.502,50", "1234.56", "42350.00"],
  },
  {
    key: "fees",
    label: "Fees",
    description: "Trading fees, commissions, or spread costs.",
    aliases: [
      "Gebühr", "Gebühren", "Provision", "Kosten", "Spread",
      "Fee", "Fees", "Commission", "Brokerage",
    ],
    required: false,
    type: "amount",
    examples: ["1.50", "0.00", "9,90"],
  },
  {
    key: "currency",
    label: "Currency",
    description: "Currency of the trade.",
    aliases: ["Währung", "CCY", "Currency", "Cur", "FX"],
    required: false,
    type: "text",
    examples: ["EUR", "USD", "GBP", "CHF"],
  },
];

// Broker CSVs take the full date-format set bank CSVs take, not a subset: the
// investment import reads the suggested id with the same parseDate() and the
// same DATE_PARSERS as the transaction import (hooks/use-investment-import.ts),
// so every id there is one it can parse. This list used to be a third
// hand-kept copy and had gone stale — missing eu-slash-short, the dotted
// month-first ids and three of the four dashed ids — with no test to notice
// (#304). It now IS the transaction list, which date-parsers.test.ts pins to
// DATE_PARSERS in both directions.
export { DATE_FORMATS };

const AMOUNT_FORMATS = [
  "de", "de-space", "us", "us-space",
  "accounting", "accounting-de", "simple", "simple-comma",
];

// ============================================================================
// Prompt Builder
// ============================================================================

function buildPrompt(
  headers: string[],
  sampleRows: Record<string, string>[]
): string {
  const fieldDescriptions = INVESTMENT_FIELDS.map(
    (f) =>
      `- **${f.key}** (${f.required ? "required" : "optional"}, type: ${f.type}): ${f.description}\n  Aliases: ${f.aliases.slice(0, 5).join(", ")}\n  Examples: ${f.examples.join(", ")}`
  ).join("\n\n");

  const columnInfo = headers
    .map((header) => {
      const samples = sampleRows
        .slice(0, 10)
        .map((row) => row[header])
        .filter((v) => v && v.trim());
      const displaySamples = samples.slice(0, 3);
      return `Column: "${header}"\nSample values: ${displaySamples.length > 0 ? displaySamples.join(" | ") : "(empty)"}`;
    })
    .join("\n\n");

  return `You are analyzing a CSV file containing investment/brokerage trade data for import into a DACH (Austria/Germany/Switzerland) accounting tool.

## Available Target Fields

${fieldDescriptions}

## CSV Columns to Match

${columnInfo}

## Instructions

For each CSV column, determine which target field it should map to.

CRITICAL RULES:
1. Each target field can ONLY be assigned to ONE column (no duplicates!)
2. If multiple columns could match a field, pick the BEST one and leave others as null
3. Required fields (date, tradeType, ticker, quantity, grossAmount) must be prioritized
4. Analyze ACTUAL SAMPLE VALUES to decide mappings — column headers can be misleading

TRADE TYPE DETECTION:
- "Open Position" / "Market Buy" / "Kauf" → buy
- "Close Position" / "Market Sell" / "Verkauf" → sell
- "Dividend" / "Dividende" → dividend
- "Rollover Fee" / "Overnight Fee" → fee

AMOUNT FORMAT DETECTION:
- "simple": No thousands separator, decimal point: 1234.56
- "us": Comma thousands, decimal point: 1,234.56
- "de": Dot thousands, comma decimal: 1.234,56
- "simple-comma": Comma decimal, no thousands: 1234,56

Valid date format IDs: ${DATE_FORMATS.join(", ")}
Valid amount format IDs: ${AMOUNT_FORMATS.join(", ")}
Valid target field keys: ${INVESTMENT_FIELDS.map((f) => f.key).join(", ")}

Respond ONLY with valid JSON (no markdown, no explanation):
{
  "mappings": [
    {"csvColumn": "column name", "targetField": "field key or null", "confidence": 0.0-1.0}
  ],
  "suggestedDateFormat": "format id or null",
  "suggestedAmountFormat": "format id or null"
}`;
}

// ============================================================================
// Cloud Function
// ============================================================================

export const matchInvestmentColumns = onCall<MatchInvestmentColumnsRequest>(
  {
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (request): Promise<MatchInvestmentColumnsResponse> => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }
    const userId = request.auth.uid;
    const { headers, sampleRows } = request.data;

    if (!headers || !Array.isArray(headers) || headers.length === 0) {
      throw new HttpsError("invalid-argument", "headers array is required");
    }
    if (!sampleRows || !Array.isArray(sampleRows)) {
      throw new HttpsError("invalid-argument", "sampleRows array is required");
    }

    console.log(`[matchInvestmentColumns] Matching ${headers.length} columns with ${sampleRows.length} sample rows`);

    try {
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

      const text = responseData.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new HttpsError("internal", "No text response from AI");
      }

      // Parse JSON response
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

      let result: MatchInvestmentColumnsResponse;
      try {
        result = JSON.parse(jsonText);
      } catch {
        console.error("[matchInvestmentColumns] Failed to parse AI response:", jsonText);
        throw new HttpsError("internal", "Failed to parse AI response as JSON");
      }

      if (!result.mappings || !Array.isArray(result.mappings)) {
        throw new HttpsError("internal", "Invalid response structure from AI");
      }

      // Validate mappings
      const validFieldKeys = new Set(INVESTMENT_FIELDS.map((f) => f.key));
      result.mappings = result.mappings.map((m) => ({
        csvColumn: m.csvColumn,
        targetField: m.targetField && validFieldKeys.has(m.targetField) ? m.targetField : null,
        confidence: typeof m.confidence === "number" ? Math.min(1, Math.max(0, m.confidence)) : 0,
      }));

      // Deduplicate: each target field can only be used once
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

      result.mappings = result.mappings.map((m) => {
        if (!m.targetField) return m;
        const winner = usedFields.get(m.targetField);
        if (winner && winner.csvColumn !== m.csvColumn) {
          return { ...m, targetField: null, confidence: 0 };
        }
        return m;
      });

      // Validate format suggestions
      if (result.suggestedDateFormat && !DATE_FORMATS.includes(result.suggestedDateFormat)) {
        result.suggestedDateFormat = "de";
      }
      if (result.suggestedAmountFormat && !AMOUNT_FORMATS.includes(result.suggestedAmountFormat)) {
        result.suggestedAmountFormat = "de";
      }

      console.log(`[matchInvestmentColumns] Matched ${result.mappings.filter((m) => m.targetField).length} columns`);

      return result;
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      console.error("[matchInvestmentColumns] Error:", error);
      throw new HttpsError(
        "internal",
        `AI matching failed: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
);
