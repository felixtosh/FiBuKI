/**
 * Callable Cloud Function for generating Gmail search queries
 * Uses Gemini Flash Lite for intelligent suggestions
 * Caches results on the transaction document for consistency between UI and Agent
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { createHash } from "crypto";
import { generateTypedQueriesWithGemini } from "./generateQueriesWithGemini";
import {
  suggestionTerms,
  QueryGenerationPartner,
  TypedSuggestion,
} from "./generateSearchQueries";

const db = getFirestore();

/** Cache TTL in milliseconds (30 days) */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface GenerateSearchQueriesRequest {
  /** Transaction ID for cache read/write (optional for backward compatibility) */
  transactionId?: string;
  transaction: {
    name: string;
    partner?: string | null;
    description?: string;
    reference?: string;
    partnerId?: string | null;
    partnerType?: "global" | "user" | null;
    amount?: number;
  };
  maxQueries?: number;
  /** Force regeneration even if cached */
  forceRefresh?: boolean;
}

interface GenerateSearchQueriesResponse {
  queries: string[];
  /** Typed suggestions with category info for UI pills */
  suggestions: TypedSuggestion[];
  /** Whether result came from cache */
  fromCache?: boolean;
}

/**
 * Generate a hash of partner data for cache invalidation.
 * When partner's emailDomains, aliases, or fileSourcePatterns change,
 * the hash will differ and trigger regeneration.
 */
function hashPartnerData(partner: QueryGenerationPartner | undefined): string {
  if (!partner) return "";
  const data = {
    name: partner.name || "",
    emailDomains: (partner.emailDomains || []).slice().sort(),
    aliases: (partner.aliases || []).slice().sort(),
    fileSourcePatterns: (partner.fileSourcePatterns || [])
      .map((p) => p.pattern)
      .sort(),
  };
  return createHash("md5").update(JSON.stringify(data)).digest("hex");
}

/**
 * Check if cached suggestions are still valid
 */
function isCacheValid(
  cached: {
    suggestions: TypedSuggestion[];
    generatedAt: Timestamp;
    partnerId?: string | null;
    partnerDataHash?: string;
  },
  currentPartnerId: string | null | undefined,
  currentPartnerHash: string
): boolean {
  // Check if partner changed
  if ((cached.partnerId || null) !== (currentPartnerId || null)) {
    return false;
  }

  // Check if partner data changed (emailDomains, aliases, etc.)
  if ((cached.partnerDataHash || "") !== currentPartnerHash) {
    return false;
  }

  // Check TTL
  const generatedAt = cached.generatedAt?.toMillis?.() || 0;
  if (Date.now() - generatedAt > CACHE_TTL_MS) {
    return false;
  }

  // Must have at least one suggestion
  if (!cached.suggestions || cached.suggestions.length === 0) {
    return false;
  }

  return true;
}

/**
 * Generate Gmail search queries for a transaction using Gemini
 * Caches results on the transaction document
 */
export const generateSearchQueriesCallable = onCall<
  GenerateSearchQueriesRequest,
  Promise<GenerateSearchQueriesResponse>
>(
  {
    region: "europe-west1",
    memory: "256MiB",
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be authenticated");
    }

    const { transactionId, transaction, maxQueries = 8, forceRefresh = false } = request.data;

    if (!transaction || !transaction.name) {
      throw new HttpsError("invalid-argument", "Transaction with name is required");
    }

    // Fetch partner data if partnerId is provided
    let partnerData: QueryGenerationPartner | undefined;
    if (transaction.partnerId) {
      const collection = transaction.partnerType === "global" ? "globalPartners" : "partners";
      const partnerDoc = await db.collection(collection).doc(transaction.partnerId).get();

      if (partnerDoc.exists) {
        const data = partnerDoc.data()!;
        partnerData = {
          name: data.name,
          emailDomains: data.emailDomains,
          website: data.website,
          ibans: data.ibans,
          vatId: data.vatId,
          aliases: data.aliases,
          fileSourcePatterns: data.fileSourcePatterns,
        };
      }
    }

    // Compute partner data hash for cache validation
    const partnerDataHash = hashPartnerData(partnerData);

    // Try to use cached suggestions if transactionId provided
    if (transactionId && !forceRefresh) {
      try {
        const txDoc = await db.collection("transactions").doc(transactionId).get();
        if (txDoc.exists) {
          const txData = txDoc.data();
          const cached = txData?.searchSuggestions;

          // Check if user owns this transaction
          if (txData?.userId !== request.auth.uid) {
            throw new HttpsError("permission-denied", "Not authorized to access this transaction");
          }

          if (cached && isCacheValid(cached, transaction.partnerId, partnerDataHash)) {
            // Cache hit. Suggestions cached before #240 carry no terms, and a
            // 30-day TTL is a long time to serve a search the attach path
            // cannot execute — so they are lowered on the way out.
            const suggestions = cached.suggestions.map((s: TypedSuggestion) => ({
              ...s,
              terms: s.terms ?? suggestionTerms(s.query, s.type),
            }));
            return {
              queries: suggestions.map((s: TypedSuggestion) => s.query),
              suggestions,
              fromCache: true,
            };
          }
        }
      } catch (error) {
        // If cache read fails, continue to generate new suggestions
        if ((error as { code?: string })?.code === "permission-denied") {
          throw error;
        }
        console.warn("[generateSearchQueriesCallable] Cache read failed:", error);
      }
    }

    // Generate typed suggestions using Gemini (sorted by search effectiveness)
    const suggestions = await generateTypedQueriesWithGemini(
      {
        name: transaction.name,
        partner: transaction.partner,
        description: transaction.description,
        reference: transaction.reference,
        amount: transaction.amount,
      },
      partnerData,
      maxQueries,
      request.auth.uid
    );

    // Save to cache if transactionId provided
    if (transactionId && suggestions.length > 0) {
      try {
        await db.collection("transactions").doc(transactionId).update({
          searchSuggestions: {
            suggestions,
            generatedAt: FieldValue.serverTimestamp(),
            partnerId: transaction.partnerId || null,
            partnerDataHash,
          },
          updatedAt: FieldValue.serverTimestamp(),
        });
      } catch (error) {
        // Cache write failure is not fatal - log and continue
        console.warn("[generateSearchQueriesCallable] Cache write failed:", error);
      }
    }

    // Also return plain queries for backward compatibility
    const queries = suggestions.map((s) => s.query);

    return {
      queries,
      suggestions,
      fromCache: false,
    };
  }
);
