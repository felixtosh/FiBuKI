/**
 * Gemini-powered search query generation
 * Used by both UI (via callable) and automation (precision search)
 */

import { VertexAI } from "@google-cloud/vertexai";
import {
  generateTypedSearchQueries,
  suggestionTerms,
  QueryGenerationTransaction,
  QueryGenerationPartner,
  TypedSuggestion,
  SuggestionType,
} from "./generateSearchQueries";
import { logAIUsage } from "../utils/ai-usage-logger";
import { MODELS } from "../utils/models";

const GEMINI_MODEL = MODELS.geminiLite;
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || "europe-west1";

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

/**
 * Fix common JSON issues from LLM output
 */
function fixLlmJson(text: string): string {
  return text
    .replace(/,(\s*[}\]])/g, "$1")
    .replace(/```json\s*/g, "")
    .replace(/```\s*/g, "");
}

export interface GeminiQueryInput {
  name: string;
  partner?: string | null;
  description?: string;
  reference?: string;
  amount?: number; // in cents
}

/** Valid suggestion types that Gemini can return */
const VALID_TYPES: SuggestionType[] = [
  "invoice_number",
  "company_name",
  "email_domain",
  "vat_id",
  "iban",
  "pattern",
  "fallback",
];

/** Words that should never be suggestions on their own */
const BLOCKED_WORDS = new Set([
  "money", "payment", "added", "from", "to", "the", "for", "and", "inc", "llc", "gmbh", "ag",
  "transfer", "bank", "credit", "debit", "card", "transaction", "purchase", "order",
]);

/**
 * Check if a query is valid (not blocked/generic)
 */
function isValidQuery(query: string): boolean {
  const normalized = query.toLowerCase().trim();

  // Too short
  if (normalized.length < 2) return false;

  // Single blocked word
  if (BLOCKED_WORDS.has(normalized)) return false;

  // Looks like bank transaction text (contains multiple blocked words)
  const words = normalized.split(/\s+/);
  const blockedCount = words.filter(w => BLOCKED_WORDS.has(w)).length;
  if (blockedCount >= 2) return false;

  // UUID that's not an invoice (contains too many hex chars in a row)
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(normalized)) {
    return false;
  }

  return true;
}

/**
 * Generate typed search queries using Gemini
 * Returns suggestions in Gemini's recommended order (best first)
 */
export async function generateTypedQueriesWithGemini(
  transaction: GeminiQueryInput,
  partnerData?: QueryGenerationPartner | null,
  maxQueries: number = 5,
  userId?: string
): Promise<TypedSuggestion[]> {
  // Get deterministic suggestions as fallback
  const txData: QueryGenerationTransaction = {
    name: transaction.name,
    partner: transaction.partner,
    description: transaction.description,
    reference: transaction.reference,
  };
  const deterministicSuggestions = generateTypedSearchQueries(txData, partnerData, maxQueries);

  // Try Gemini for smarter suggestions
  try {
    const projectId = getProjectId();
    const vertexAI = new VertexAI({ project: projectId, location: VERTEX_LOCATION });
    const model = vertexAI.getGenerativeModel({ model: GEMINI_MODEL });

    const amount = transaction.amount
      ? `€${Math.abs(transaction.amount / 100).toFixed(2)}`
      : "unknown";

    const prompt = `Generate 4-5 Gmail search terms to find an invoice/receipt for this bank transaction.

Transaction:
- Bank text: "${transaction.name}"
- Partner: ${transaction.partner || "Unknown"}
- Amount: ${amount}
${transaction.description ? `- Description: ${transaction.description}` : ""}
${transaction.reference ? `- Reference: ${transaction.reference}` : ""}

${partnerData ? `Known partner info:
- Company: ${partnerData.name}
- Email domains: ${partnerData.emailDomains?.join(", ") || "unknown"}
- Website: ${partnerData.website || "unknown"}` : ""}

Types (use exactly these):
- "invoice_number": Invoice/reference numbers only (e.g., "r-2024.014", "INV-12345")
- "company_name": Just the company name, one word (e.g., "ouster", "netflix", "amazon")
- "email_domain": Email domain with from: prefix (e.g., "from:ouster.com")
- "fallback": Company + keyword (e.g., "ouster invoice")

CRITICAL RULES:
1. Extract ONLY the company name - "Money added from OUSTER, INC." → company is "ouster"
2. NEVER include bank transaction phrases like "money added from", "payment to", etc.
3. NEVER use generic words alone: "money", "payment", "added", "from"
4. Keep suggestions SHORT - 1-2 words max (except fallback which can be 2-3)
5. Sort by most likely to find the invoice (best first)
6. No duplicates, no UUIDs unless they're actual invoice numbers

Return ONLY valid JSON:
{"suggestions": [{"query": "r-2024.014", "type": "invoice_number"}, {"query": "ouster", "type": "company_name"}]}`;

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });

    // Log AI usage for search query generation
    const usageMetadata = result.response.usageMetadata;
    if (userId && usageMetadata) {
      logAIUsage(userId, {
        function: "searchQueryGeneration",
        model: GEMINI_MODEL,
        inputTokens: usageMetadata.promptTokenCount || 0,
        outputTokens: usageMetadata.candidatesTokenCount || 0,
      }).catch((err) => {
        console.error("[generateTypedQueriesWithGemini] Failed to log AI usage:", err);
      });
    }

    const text = result.response.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const cleanedText = fixLlmJson(text);
    const jsonMatch = cleanedText.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const geminiSuggestions = parsed.suggestions || [];

      if (geminiSuggestions.length > 0) {
        const seen = new Set<string>();
        const results: TypedSuggestion[] = [];

        const normalizeQuery = (s: string) => {
          let normalized = String(s || "").trim().toLowerCase();
          normalized = normalized.replace(/([a-z])-\s+(\d)/g, "$1-$2");
          normalized = normalized.replace(/(\d)\s+-([a-z\d])/g, "$1-$2");
          return normalized;
        };

        // Takes only the two fields it reads: Gemini's raw suggestions have no
        // score of their own and no terms until they are lowered below.
        const addIfNew = (
          suggestion: { query: string; type: SuggestionType },
          score: number
        ) => {
          const normalized = normalizeQuery(suggestion.query);
          if (!normalized || seen.has(normalized)) return false;
          if (!isValidQuery(normalized)) return false;

          seen.add(normalized);
          const type = VALID_TYPES.includes(suggestion.type) ? suggestion.type : "fallback";
          // Gemini is prompted in Gmail's dialect and answers in it; the terms
          // are read back off its string so what leaves here is neutral (#240).
          results.push({
            query: normalized,
            type,
            score,
            terms: suggestionTerms(normalized, type),
          });
          return true;
        };

        // Add Gemini suggestions in order (trust Gemini's sorting)
        let score = 100;
        for (const s of geminiSuggestions) {
          if (s && typeof s === "object" && s.query) {
            addIfNew({ query: s.query, type: s.type || "fallback" }, score);
            score -= 10;
          }
        }

        // Add deterministic suggestions as fallback (lower scores)
        for (const s of deterministicSuggestions) {
          if (results.length >= maxQueries) break;
          addIfNew(s, score);
          score -= 5;
        }

        // Keep Gemini's order (already sorted by insertion)
        return results.slice(0, maxQueries);
      }
    }
  } catch (error) {
    console.warn("[generateTypedQueriesWithGemini] Gemini failed, using deterministic:", error);
  }

  // Fallback to deterministic with filtering
  return deterministicSuggestions
    .filter((s) => isValidQuery(s.query))
    .slice(0, maxQueries);
}

/**
 * Legacy function - returns just query strings for backward compatibility
 */
export async function generateQueriesWithGemini(
  transaction: GeminiQueryInput,
  partnerData?: QueryGenerationPartner | null,
  maxQueries: number = 8,
  userId?: string
): Promise<string[]> {
  const typed = await generateTypedQueriesWithGemini(transaction, partnerData, maxQueries, userId);
  return typed.map((s) => s.query);
}
