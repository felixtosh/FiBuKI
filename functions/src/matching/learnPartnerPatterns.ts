import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { VertexAI } from "@google-cloud/vertexai";
import { logAIUsage } from "../utils/ai-usage-logger";
import { globMatch, matchPatternFlexible } from "../utils/pattern-utils";

// Using Gemini Flash Lite for pattern learning
const GEMINI_MODEL = "gemini-2.0-flash-lite-001";
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || "europe-west1";

// ============================================================================
// Pattern Safety Configuration
// ============================================================================

/**
 * Common German banking/invoice words that are too generic as standalone patterns.
 * Patterns containing ONLY these (e.g., "*rechnung*") are auto-rejected.
 * This is the only hard rule - everything else is left to AI judgment with good context.
 */
const GENERIC_BANKING_TERMS = [
  "rechnung",      // invoice
  "rechner",       // calculator/computer
  "rechn",         // partial "rechnung"
  "ueberweisung",  // bank transfer
  "überweisung",   // bank transfer
  "lastschrift",   // direct debit
  "gutschrift",    // credit
  "zahlung",       // payment
  "bezahlung",     // payment
  "abbuchung",     // debit
  "einzahlung",    // deposit
  "auszahlung",    // withdrawal
  "konto",         // account
  "sepa",          // SEPA
  "mandat",        // mandate
  "referenz",      // reference
  "verwendung",    // purpose
  "betrag",        // amount
  "iban",          // IBAN
  "bic",           // BIC
  "nr",            // number (as in "Rechn.Nr.")
];

/**
 * Check if a pattern is a standalone generic banking term.
 * Only rejects patterns that are PURELY generic (e.g., "*rechnung*", "*rechn*r*").
 * Patterns with specific content (e.g., "*amazon*rechnung*") are allowed through for AI review.
 */
function checkPatternSafety(
  pattern: string,
  matchCount: number,
  totalTransactions: number,
  sourceTransactionCount: number
): { rejected: boolean; reason?: string } {
  const normalizedPattern = pattern.toLowerCase().replace(/\*/g, "");

  // Extract meaningful words from pattern (ignore single chars)
  const patternParts = normalizedPattern.split(/[^a-zäöüß]+/).filter((p) => p.length >= 2);

  // Check if pattern consists ONLY of generic banking terms
  // E.g., "*rechnung*" → ["rechnung"] → all generic → REJECT
  // E.g., "*amazon*rechnung*" → ["amazon", "rechnung"] → "amazon" not generic → ALLOW for AI review
  // E.g., "*rechn*r*" → ["rechn", "r"] → "rechn" is generic partial → REJECT
  if (patternParts.length > 0) {
    const allPartsGeneric = patternParts.every((part) =>
      GENERIC_BANKING_TERMS.some((term) =>
        // Match if part equals term, or is a substring (like "rechn" in "rechnung")
        part === term || term.startsWith(part) || part.startsWith(term)
      )
    );

    if (allPartsGeneric) {
      return {
        rejected: true,
        reason: `Pattern "${pattern}" contains only generic banking terms (${patternParts.join(", ")}) - would match many unrelated transactions`,
      };
    }
  }

  // All other decisions left to AI with proper context
  // The AI sees: match count, match percentage, sample transactions
  return { rejected: false };
}

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

const db = getFirestore();

// ============================================================================
// Types
// ============================================================================

interface LearnPatternsRequest {
  partnerId: string;
  transactionId?: string; // Optional: the newly assigned transaction
}

interface CollisionTransaction {
  partner: string | null;
  name: string;
  assignedPartnerId: string;
  assignedPartnerName: string;
}

/**
 * Record of a transaction that was manually removed from this partner.
 * Used as negative training signal (false positive) for pattern learning.
 */
interface ManualRemovalRecord {
  transactionId: string;
  partner: string | null;
  name: string;
}

interface LearnedPattern {
  pattern: string;
  /** DEPRECATED: field is ignored, patterns match all text fields combined */
  field?: "partner" | "name";
  confidence: number;
  createdAt: Timestamp;
  sourceTransactionIds: string[];
}

interface AIPatternResponse {
  patterns: Array<{
    pattern: string;
    confidence: number;
    reasoning: string;
    excludePatterns?: string[];
  }>;
}

interface AIVerificationResponse {
  verified: Array<{
    pattern: string;
    approved: boolean;
    adjustedConfidence?: number;
    reason?: string;
  }>;
}

interface LearnPatternsResponse {
  patternsLearned: number;
  patterns: Array<{
    pattern: string;
    confidence: number;
  }>;
}

// ============================================================================
// Pattern Dry-Run Verification
// ============================================================================

interface DryRunMatch {
  id: string;
  name: string;
  partner: string | null;
  isAssignedToOther: boolean;
  otherPartnerName?: string;
}

/**
 * Build verification prompt that shows LLM what transactions WOULD match each pattern
 */
function buildVerificationPrompt(
  partnerName: string,
  proposedPatterns: Array<{ pattern: string; confidence: number }>,
  dryRunResults: Map<string, DryRunMatch[]>,
  totalTransactions?: number
): string {
  const sections = proposedPatterns.map((p) => {
    const matches = dryRunResults.get(p.pattern) || [];
    const unassigned = matches.filter((m) => !m.isAssignedToOther);
    const conflicts = matches.filter((m) => m.isAssignedToOther);

    // Calculate match percentage for warning
    const matchPercent = totalTransactions ? ((matches.length / totalTransactions) * 100).toFixed(1) : null;
    const isBroad = matches.length > 20 || (matchPercent && parseFloat(matchPercent) > 3);

    return `## Pattern: "${p.pattern}" (proposed confidence: ${p.confidence}%)

⚠️ MATCH STATISTICS: Would match ${matches.length} transactions${matchPercent ? ` (${matchPercent}% of all ${totalTransactions})` : ""}${isBroad ? " - THIS IS A LOT, BE CAREFUL!" : ""}

${unassigned.length > 0 ? `UNASSIGNED (will be auto-assigned to ${partnerName}):
${unassigned.slice(0, 15).map((m) => `- "${m.partner || "(no partner)"}" | "${m.name}"`).join("\n")}
${unassigned.length > 15 ? `... and ${unassigned.length - 15} more (REVIEW CAREFULLY - too many matches is suspicious!)` : ""}` : "(none unassigned)"}

${conflicts.length > 0 ? `CONFLICTS (already assigned to OTHER partners):
${conflicts.slice(0, 5).map((m) => `- "${m.partner || "(no partner)"}" | "${m.name}" → currently: ${m.otherPartnerName}`).join("\n")}
${conflicts.length > 5 ? `... and ${conflicts.length - 5} more conflicts` : ""}` : "(no conflicts)"}`;
  });

  return `You are VERIFYING patterns for partner "${partnerName}".

Below are proposed patterns and what transactions they WOULD match if applied.
Review each pattern and decide whether to APPROVE or REJECT it.

⚠️ IMPORTANT: Be VERY suspicious of patterns that match many transactions!
- Patterns matching >20 transactions are often too generic
- Patterns with common German words (rechnung, überweisung, zahlung) are usually wrong
- A good pattern should be SPECIFIC to this partner, not generic banking terms

${sections.join("\n\n")}

## Instructions
For each pattern, verify:
1. Do ALL the matched transactions clearly belong to "${partnerName}"?
2. Is the pattern SPECIFIC enough? (Generic patterns like "*rechnung*" are WRONG)
3. Are there any false positives (transactions that shouldn't match)?
4. Does the match count seem reasonable? (>20 matches is suspicious)

REJECT patterns that:
- Match generic German banking terms (rechnung, überweisung, zahlung, lastschrift)
- Match too many transactions (>20 is suspicious unless all clearly belong to this partner)
- Have ANY conflicts with other partners
- Could plausibly match future unrelated transactions

Respond ONLY with valid JSON:
{
  "verified": [
    {"pattern": "google*", "approved": true, "adjustedConfidence": 95},
    {"pattern": "*rechnung*", "approved": false, "reason": "too generic - matches any invoice"}
  ]
}`;
}

/**
 * Run dry-run matching to see what transactions WOULD match proposed patterns
 */
async function dryRunPatternMatch(
  userId: string,
  partnerId: string,
  proposedPatterns: Array<{ pattern: string; confidence: number }>,
  partnerNameMap: Map<string, string>
): Promise<Map<string, DryRunMatch[]>> {
  const results = new Map<string, DryRunMatch[]>();

  // Get all user transactions
  const allTxSnapshot = await db
    .collection("transactions")
    .where("userId", "==", userId)
    .limit(1000)
    .get();

  for (const pattern of proposedPatterns) {
    const matches: DryRunMatch[] = [];

    for (const txDoc of allTxSnapshot.docs) {
      const txData = txDoc.data();
      const txName = txData.name || null;
      const txPartner = txData.partner || null;
      const txReference = txData.reference || null;

      // Use flexible matching that tries multiple field combinations
      if (matchPatternFlexible(pattern.pattern.toLowerCase(), txName, txPartner, txReference)) {
        const existingPartnerId = txData.partnerId;
        const isAssignedToOther = existingPartnerId && existingPartnerId !== partnerId;

        matches.push({
          id: txDoc.id,
          name: txData.name || "",
          partner: txData.partner || null,
          isAssignedToOther: !!isAssignedToOther,
          otherPartnerName: isAssignedToOther ? partnerNameMap.get(existingPartnerId) || "Unknown" : undefined,
        });
      }
    }

    results.set(pattern.pattern, matches);
  }

  return results;
}

// ============================================================================
// Prompt Builder
// ============================================================================

function buildPrompt(
  partnerName: string,
  partnerAliases: string[],
  assignedTransactions: Array<{ id: string; partner: string | null; name: string }>,
  collisionTransactions: CollisionTransaction[],
  manualRemovals: ManualRemovalRecord[] = []
): string {
  const assignedList = assignedTransactions
    .map((tx) => `- partner: "${tx.partner || "(empty)"}" | name: "${tx.name}"`)
    .join("\n");

  // Group collision transactions by partner for clearer display
  const collisionList = collisionTransactions
    .slice(0, 30) // Limit to 30 samples
    .map((tx) => `- partner: "${tx.partner || "(empty)"}" | name: "${tx.name}" → assigned to: ${tx.assignedPartnerName}`)
    .join("\n");

  // Manual removals - transactions user explicitly said are NOT this partner
  const removalsList = manualRemovals
    .slice(0, 20) // Limit to 20 samples
    .map((tx) => `- partner: "${tx.partner || "(empty)"}" | name: "${tx.name}"`)
    .join("\n");

  return `You are analyzing bank transaction data to learn matching patterns for a partner.

## Partner Information
Name: ${partnerName}
Existing Aliases: ${partnerAliases.length > 0 ? partnerAliases.join(", ") : "(none)"}

## MUST MATCH - Transactions assigned to this partner
Your patterns MUST match ALL of these:
${assignedList || "(no transactions yet)"}

## MUST NOT MATCH - FALSE POSITIVES (user explicitly removed these)
These transactions were auto-matched but the user said they are WRONG. Your patterns MUST NOT match any of these:
${removalsList || "(none)"}

## MUST NOT MATCH - Transactions assigned to OTHER partners
Your patterns must NOT match ANY of these (collision check):
${collisionList || "(no other assigned transactions)"}

## Instructions

Generate glob-style patterns that will match future transactions from this partner.

IMPORTANT: Prefer GENERAL patterns over specific ones!
- If all transactions start with "Google", use "google*" not "google*cloud*", "google*ads*" separately
- Only be specific when necessary to avoid collisions with other partners
- Simpler patterns = better (easier to match future variations)

Pattern Rules:
1. Use * as a wildcard (matches any characters, including spaces)
2. Patterns must match ALL "must match" transactions
3. Patterns must NOT match ANY "must not match" transactions
4. Prefer shorter, more general patterns when safe
5. CRITICAL: Handle spelling variations by using * between word parts!
   - "Media Markt" and "Mediamarkt" → use "*media*markt*" (not "*media markt*")
   - Spaces and no-spaces are different! Use * to match both
6. Common pattern examples:
   - "google*" matches all Google services (Cloud, Ads, YouTube, etc.)
   - "amazon*" matches "AMAZON.DE", "AMAZON EU SARL"
   - "*netflix*" matches "NETFLIX.COM", "PP*NETFLIX"
   - "*media*markt*" matches "Media Markt", "Mediamarkt", "MEDIAMARKT 1070"

Confidence Guidelines:
- 95-100: General pattern that matches all transactions without any collisions
- 85-94: Good pattern with low collision risk
- 70-84: More specific pattern needed to avoid collisions
- Below 70: Don't suggest patterns this weak

Respond ONLY with valid JSON (no markdown, no explanation):
{
  "patterns": [
    {
      "pattern": "google*",
      "confidence": 95,
      "reasoning": "All Google transactions start with 'google' and no collisions with other partners",
      "excludePatterns": ["*cloud*", "*workspace*"]
    }
  ]
}

Notes on excludePatterns:
- Use excludePatterns to EXCLUDE specific transactions that would otherwise match
- Derived from the FALSE POSITIVES list (user explicitly said these are NOT this partner)
- Example: If "*paypal*" matches both PayPal payments and "PayPal *foodora", but user removed "PayPal *foodora", add excludePatterns: ["*foodora*"]
- Only include excludePatterns if there are false positives that need explicit exclusion
- excludePatterns is optional - omit if not needed

If no good patterns can be learned (e.g., only 1 transaction with no clear pattern), return:
{"patterns": []}`;
}

// ============================================================================
// Helper: Re-match unassigned transactions
// ============================================================================

interface MatchedTransaction {
  id: string;
  name: string;
  amount: number;
  partner?: string;
}

interface RematchResult {
  matchedCount: number;
  matchedTransactions: MatchedTransaction[];
}

/**
 * Re-match unassigned transactions against newly learned patterns
 * Auto-assigns if pattern confidence >= 89%
 *
 * IMPORTANT: Skips transactions that are in manualRemovals (user explicitly removed them)
 */
async function rematchUnassignedTransactions(
  userId: string,
  partnerId: string,
  partnerName: string,
  learnedPatterns: LearnedPattern[],
  manualRemovalIds: Set<string> = new Set()
): Promise<RematchResult> {
  // Get ALL user transactions and filter client-side
  // (Firestore "== null" doesn't match missing/undefined fields)
  const allTxSnapshot = await db
    .collection("transactions")
    .where("userId", "==", userId)
    .limit(1000)
    .get();

  if (allTxSnapshot.empty) return { matchedCount: 0, matchedTransactions: [] };

  // Filter to unassigned transactions (partnerId is null, undefined, or missing)
  const unassignedDocs = allTxSnapshot.docs.filter((doc) => {
    const data = doc.data();
    return !data.partnerId;
  });

  console.log(`Found ${unassignedDocs.length} unassigned transactions to check`);
  console.log(`Excluding ${manualRemovalIds.size} transactions that user manually removed`);

  if (unassignedDocs.length === 0) return { matchedCount: 0, matchedTransactions: [] };

  const batch = db.batch();
  let matchedCount = 0;
  const matchedTransactions: MatchedTransaction[] = [];

  for (const txDoc of unassignedDocs) {
    const txData = txDoc.data();

    // CRITICAL: Skip transactions that user explicitly removed from this partner
    if (manualRemovalIds.has(txDoc.id)) {
      console.log(`  -> SKIPPING tx ${txDoc.id} - user manually removed it from this partner`);
      continue;
    }

    let bestMatch: { confidence: number; pattern: string } | null = null;

    const txName = txData.name || null;
    const txPartner = txData.partner || null;
    const txReference = txData.reference || null;

    // Check if we have any text to match
    if (!txName && !txPartner && !txReference) continue;

    // Check each pattern against transaction using flexible matching
    for (const pattern of learnedPatterns) {
      if (matchPatternFlexible(pattern.pattern, txName, txPartner, txReference)) {
        const debugText = [txName, txPartner, txReference].filter(Boolean).join(" | ");
        console.log(`  -> MATCH: "${pattern.pattern}" on fields="${debugText}" (${pattern.confidence}%)`);
        if (!bestMatch || pattern.confidence > bestMatch.confidence) {
          bestMatch = { confidence: pattern.confidence, pattern: pattern.pattern };
        }
      }
    }

    // Auto-assign if best match confidence >= 89%
    if (bestMatch && bestMatch.confidence >= 89) {
      console.log(`  -> AUTO-ASSIGNING with confidence ${bestMatch.confidence}%`);
      batch.update(txDoc.ref, {
        partnerId: partnerId,
        partnerType: "user",
        partnerMatchConfidence: bestMatch.confidence,
        partnerMatchedBy: "auto",
        partnerSuggestions: [{
          partnerId: partnerId,
          partnerType: "user",
          confidence: bestMatch.confidence,
          source: "pattern",
        }],
        updatedAt: FieldValue.serverTimestamp(),
      });
      matchedCount++;

      // Collect transaction data for preview (limit to 10)
      if (matchedTransactions.length < 10) {
        matchedTransactions.push({
          id: txDoc.id,
          name: txData.name || txData.partner || "Unknown",
          amount: txData.amount || 0,
          partner: txData.partner,
        });
      }
    } else if (bestMatch) {
      console.log(`  -> Confidence too low (${bestMatch.confidence}% < 89%), skipping auto-assign`);
    }

    // Batch limit
    if (matchedCount >= 100) break;
  }

  if (matchedCount > 0) {
    await batch.commit();
  }

  return { matchedCount, matchedTransactions };
}

// ============================================================================
// Helper: Cascade unassign auto-matched transactions
// ============================================================================

/**
 * Unassign auto-matched transactions that no longer match the current patterns.
 * Called when patterns are updated or cleared to maintain consistency.
 *
 * @param userId - The user ID
 * @param partnerId - The partner ID whose auto-assignments to check
 * @param newPatterns - The new patterns to check against (empty = unassign all)
 * @returns Number of transactions that were unassigned
 */
async function cascadeUnassignTransactions(
  userId: string,
  partnerId: string,
  newPatterns: LearnedPattern[] = []
): Promise<number> {
  // Get all transactions assigned to this partner
  // We can't use compound queries with "in" on partnerMatchedBy because we also need
  // to handle legacy transactions without the field, so we fetch all and filter client-side
  const allAssignedSnapshot = await db
    .collection("transactions")
    .where("userId", "==", userId)
    .where("partnerId", "==", partnerId)
    .limit(500)
    .get();

  // Filter to only auto-matched OR legacy transactions without partnerMatchedBy
  // Manual/suggestion assignments are user decisions and should NOT be cascade-unassigned
  const autoAssignedDocs = allAssignedSnapshot.docs.filter((doc) => {
    const data = doc.data();
    const matchedBy = data.partnerMatchedBy;
    // Include: "auto", null, undefined, or missing field (legacy)
    return matchedBy === "auto" || !matchedBy;
  });

  if (autoAssignedDocs.length === 0) return 0;

  console.log(`Found ${autoAssignedDocs.length} auto/legacy-assigned transactions to re-evaluate (of ${allAssignedSnapshot.size} total)`);

  const batch = db.batch();
  let unassignedCount = 0;

  for (const txDoc of autoAssignedDocs) {
    const txData = txDoc.data();

    // If we have new patterns, check if transaction still matches
    if (newPatterns.length > 0) {
      const txName = txData.name || null;
      const txPartner = txData.partner || null;
      const txReference = txData.reference || null;

      let stillMatches = false;

      for (const pattern of newPatterns) {
        // Use flexible matching that tries multiple field combinations
        if (matchPatternFlexible(pattern.pattern, txName, txPartner, txReference)) {
          // Check confidence meets threshold (no penalty)
          if (pattern.confidence >= 89) {
            stillMatches = true;
            break;
          }
        }
      }

      if (stillMatches) continue; // Keep this assignment
    }

    // Unassign transaction (no matching pattern or patterns are empty)
    batch.update(txDoc.ref, {
      partnerId: null,
      partnerType: null,
      partnerMatchedBy: null,
      partnerMatchConfidence: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    unassignedCount++;
  }

  if (unassignedCount > 0) {
    await batch.commit();
    console.log(`Cascade-unassigned ${unassignedCount} transactions that no longer match patterns`);
  }

  return unassignedCount;
}

// ============================================================================
// Cloud Function
// ============================================================================

/**
 * Learn matching patterns for a partner based on assigned transactions
 * Called after a user manually assigns a partner to a transaction
 */
export const learnPartnerPatterns = onCall<LearnPatternsRequest>(
  {
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (request): Promise<LearnPatternsResponse> => {
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }
    const userId = request.auth.uid;
    const { partnerId, transactionId } = request.data;

    if (!partnerId) {
      throw new HttpsError("invalid-argument", "partnerId is required");
    }

    console.log(`Learning patterns for partner ${partnerId}, triggered by transaction ${transactionId || "manual"}`);

    try {
      // 1. Fetch the partner
      const partnerDoc = await db.collection("partners").doc(partnerId).get();
      if (!partnerDoc.exists) {
        throw new HttpsError("not-found", `Partner ${partnerId} not found`);
      }

      const partnerData = partnerDoc.data()!;
      if (partnerData.userId !== userId) {
        throw new HttpsError("permission-denied", "Cannot access this partner");
      }

      const partnerName = partnerData.name || "";
      const partnerAliases: string[] = partnerData.aliases || [];

      // Get manual removals (false positives) from partner data
      const manualRemovals: ManualRemovalRecord[] = (partnerData.manualRemovals || []).map(
        (r: { transactionId: string; partner: string | null; name: string }) => ({
          transactionId: r.transactionId,
          partner: r.partner || null,
          name: r.name || "",
        })
      );

      console.log(`Found ${manualRemovals.length} manual removals (false positives) for partner ${partnerId}`);

      // 2. Fetch ONLY user-assigned transactions (not auto-assigned)
      // This ensures patterns are only learned from explicit user decisions,
      // not from previous auto-matches (which could create feedback loops)
      // Includes: manual, suggestion (accepted), and ai (AI-assisted assignment)
      const assignedSnapshot = await db
        .collection("transactions")
        .where("userId", "==", userId)
        .where("partnerId", "==", partnerId)
        .where("partnerMatchedBy", "in", ["manual", "suggestion", "ai"])
        .limit(50) // Limit to avoid huge prompts
        .get();

      const assignedTransactions = assignedSnapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          partner: data.partner || null,
          name: data.name || "",
        };
      });

      // Handle case where no manual/suggestion assignments remain
      if (assignedTransactions.length === 0) {
        console.log(`No manual assignments for partner ${partnerId}, clearing patterns and cascade-unassigning`);

        // Clear all learned patterns from the partner
        await partnerDoc.ref.update({
          learnedPatterns: [],
          patternsUpdatedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        // Cascade-unassign all auto-assigned transactions (passing empty patterns)
        const unassignedCount = await cascadeUnassignTransactions(userId, partnerId, []);

        // Create notification if any transactions were unassigned
        if (unassignedCount > 0) {
          try {
            await db.collection(`users/${userId}/notifications`).add({
              type: "patterns_cleared",
              title: `Patterns cleared for ${partnerName}`,
              message: `All manual assignments removed. ${unassignedCount} auto-matched transaction${unassignedCount !== 1 ? "s were" : " was"} unassigned.`,
              createdAt: FieldValue.serverTimestamp(),
              readAt: null,
              context: {
                partnerId,
                partnerName,
                unassignedCount,
              },
            });
            console.log(`Created patterns_cleared notification for ${partnerName}`);
          } catch (err) {
            console.error("Failed to create patterns_cleared notification:", err);
          }
        }

        return { patternsLearned: 0, patterns: [] };
      }

      // 3. Fetch transactions assigned to OTHER partners (collision set)
      const allAssignedSnapshot = await db
        .collection("transactions")
        .where("userId", "==", userId)
        .limit(500)
        .get();

      const currentGlobalPartnerId = partnerData.globalPartnerId || null;

      // Get partner names for collision transactions
      const partnerIds = new Set<string>();
      allAssignedSnapshot.docs.forEach((doc) => {
        const data = doc.data();
        const pid = data.partnerId;
        if (!pid || pid === partnerId) return;
        if (currentGlobalPartnerId && pid === currentGlobalPartnerId) return;
        if (data.partnerType === "global" && data.partnerMatchedBy !== "manual" && data.partnerMatchedBy !== "suggestion") {
          return;
        }
        partnerIds.add(pid);
      });

      // Fetch partner names in bulk
      const partnerNameMap = new Map<string, string>();
      if (partnerIds.size > 0) {
        const partnerDocs = await Promise.all(
          Array.from(partnerIds).slice(0, 50).map((pid) => db.collection("partners").doc(pid).get())
        );
        partnerDocs.forEach((doc) => {
          if (doc.exists) {
            partnerNameMap.set(doc.id, doc.data()!.name || "Unknown");
          }
        });
      }
      if (partnerIds.size > 0) {
        const globalDocs = await Promise.all(
          Array.from(partnerIds).slice(0, 50).map((pid) =>
            db.collection("globalPartners").doc(pid).get()
          )
        );
        globalDocs.forEach((doc) => {
          if (doc.exists) {
            partnerNameMap.set(doc.id, doc.data()!.name || "Unknown");
          }
        });
      }

      // Build collision set
      const collisionTransactions: CollisionTransaction[] = allAssignedSnapshot.docs
        .filter((doc) => {
          const data = doc.data();
          const pid = data.partnerId;
          if (!pid || pid === partnerId) return false;
          if (currentGlobalPartnerId && pid === currentGlobalPartnerId) return false;
          if (data.partnerType === "global" && data.partnerMatchedBy !== "manual" && data.partnerMatchedBy !== "suggestion") {
            return false;
          }
          return true;
        })
        .map((doc) => {
          const data = doc.data();
          return {
            partner: data.partner || null,
            name: data.name || "",
            assignedPartnerId: data.partnerId,
            assignedPartnerName: partnerNameMap.get(data.partnerId) || "Unknown",
          };
        });

      console.log(`Found ${collisionTransactions.length} transactions assigned to other partners for collision check`);

      // 4. Call Gemini to generate patterns
      const projectId = getProjectId();
      const vertexAI = new VertexAI({ project: projectId, location: VERTEX_LOCATION });
      const model = vertexAI.getGenerativeModel({ model: GEMINI_MODEL });

      const prompt = buildPrompt(partnerName, partnerAliases, assignedTransactions, collisionTransactions, manualRemovals);

      const response = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      });

      const responseData = response.response;

      // Log AI usage
      const usageMetadata = responseData.usageMetadata;
      await logAIUsage(userId, {
        function: "patternLearning",
        model: GEMINI_MODEL,
        inputTokens: usageMetadata?.promptTokenCount || 0,
        outputTokens: usageMetadata?.candidatesTokenCount || 0,
        metadata: { partnerId },
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
      let aiResult: AIPatternResponse;

      try {
        aiResult = JSON.parse(jsonText);
      } catch (parseError) {
        console.error("Failed to parse AI response:", jsonText);
        throw new HttpsError("internal", "Failed to parse AI response as JSON");
      }

      // Validate and transform patterns
      if (!aiResult.patterns || !Array.isArray(aiResult.patterns)) {
        console.log("AI returned no patterns");

        // Still try file matching even if no patterns learned
        // (amount/date/partner scoring can still work)
        try {
          const { matchFilesForPartnerInternal } = await import("./matchFilesForPartner");
          const fileResult = await matchFilesForPartnerInternal(userId, partnerId);
          if (fileResult.autoMatched > 0 || fileResult.suggested > 0) {
            console.log(
              `File matching (no patterns) for ${partnerName}: ${fileResult.autoMatched} auto-matched`
            );
          }
        } catch (err) {
          console.error("Failed to run file matching:", err);
        }

        return { patternsLearned: 0, patterns: [] };
      }

      const now = Timestamp.now();
      const transactionIds = assignedTransactions.map((tx) => tx.id);

      // Helper to check collision with manual removals (false positives)
      const matchesFalsePositive = (pattern: string): ManualRemovalRecord | null => {
        for (const tx of manualRemovals) {
          const textToMatch = [tx.name, tx.partner]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          if (textToMatch && globMatch(pattern, textToMatch)) {
            return tx;
          }
        }
        return null;
      };

      // Pre-filter patterns for basic validation
      const candidatePatterns = aiResult.patterns
        .filter((p) => {
          if (!p.pattern || typeof p.pattern !== "string") return false;
          if (typeof p.confidence !== "number" || p.confidence < 50) return false;
          const normalizedPattern = p.pattern.toLowerCase().trim();
          const falsePositive = matchesFalsePositive(normalizedPattern);
          if (falsePositive) {
            console.log(`REJECTED pattern "${normalizedPattern}" - matches false positive: "${falsePositive.partner || falsePositive.name}"`);
            return false;
          }
          return true;
        })
        .map((p) => ({
          pattern: p.pattern.toLowerCase().trim(),
          confidence: Math.min(100, Math.max(0, Math.round(p.confidence))),
          ...(p.excludePatterns?.length ? { excludePatterns: p.excludePatterns } : {}),
        }));

      // === DRY-RUN VERIFICATION ===
      // Show LLM what transactions WOULD match before applying patterns
      let verifiedPatterns = candidatePatterns;

      if (candidatePatterns.length > 0) {
        console.log(`Running dry-run verification for ${candidatePatterns.length} candidate patterns`);

        // Run dry-run to see what would match
        const dryRunResults = await dryRunPatternMatch(userId, partnerId, candidatePatterns, partnerNameMap);

        // Get total transaction count for safety checks
        const totalTransactions = await db
          .collection("transactions")
          .where("userId", "==", userId)
          .count()
          .get()
          .then((snap) => snap.data().count);

        // === SAFETY CHECKS - Auto-reject dangerous patterns BEFORE LLM verification ===
        const safePatterns: typeof candidatePatterns = [];
        for (const cp of candidatePatterns) {
          const matches = dryRunResults.get(cp.pattern) || [];
          const safety = checkPatternSafety(
            cp.pattern,
            matches.length,
            totalTransactions,
            assignedTransactions.length
          );

          if (safety.rejected) {
            console.log(`SAFETY REJECTED pattern "${cp.pattern}": ${safety.reason}`);
            // Remove from dry-run results so LLM doesn't see it
            dryRunResults.delete(cp.pattern);
          } else {
            safePatterns.push(cp);
          }
        }

        console.log(`Safety check: ${candidatePatterns.length} candidates → ${safePatterns.length} passed`);

        // Skip LLM verification if no patterns passed safety
        if (safePatterns.length === 0) {
          console.log("All patterns rejected by safety checks");
          verifiedPatterns = [];
        } else {
          // Log dry-run results for remaining patterns
          for (const [pattern, matches] of dryRunResults) {
            const conflicts = matches.filter((m) => m.isAssignedToOther);
            console.log(`  Pattern "${pattern}": ${matches.length} matches, ${conflicts.length} conflicts`);
          }

          // Build verification prompt and call LLM
          const verifyPrompt = buildVerificationPrompt(partnerName, safePatterns, dryRunResults, totalTransactions);

          const verifyResponse = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: verifyPrompt }] }],
          });

          const verifyResponseData = verifyResponse.response;

          // Log AI usage for verification
          const verifyUsage = verifyResponseData.usageMetadata;
          await logAIUsage(userId, {
            function: "patternVerification",
            model: GEMINI_MODEL,
            inputTokens: verifyUsage?.promptTokenCount || 0,
            outputTokens: verifyUsage?.candidatesTokenCount || 0,
            metadata: { partnerId },
          });

          // Parse verification response
          const verifyText = verifyResponseData.candidates?.[0]?.content?.parts?.[0]?.text;
          if (verifyText) {
            try {
              // Handle markdown code blocks
              let verifyJsonText = verifyText.trim();
              if (verifyJsonText.startsWith("```json")) {
                verifyJsonText = verifyJsonText.slice(7);
              } else if (verifyJsonText.startsWith("```")) {
                verifyJsonText = verifyJsonText.slice(3);
              }
              if (verifyJsonText.endsWith("```")) {
                verifyJsonText = verifyJsonText.slice(0, -3);
              }
              const verifyResult: AIVerificationResponse = JSON.parse(verifyJsonText.trim());

              // Filter to only approved patterns with adjusted confidence
              // Use safePatterns (already passed safety checks)
              verifiedPatterns = safePatterns.filter((cp) => {
                const verification = verifyResult.verified?.find((v) => v.pattern === cp.pattern);
                if (!verification) return true; // Keep if not mentioned (default approve)
                if (!verification.approved) {
                  console.log(`VERIFICATION REJECTED pattern "${cp.pattern}": ${verification.reason || "no reason"}`);
                  return false;
                }
                // Apply adjusted confidence if provided
                if (verification.adjustedConfidence !== undefined) {
                  cp.confidence = verification.adjustedConfidence;
                }
                return true;
              });

              console.log(`Verification: ${safePatterns.length} safe patterns → ${verifiedPatterns.length} approved`);
            } catch (parseErr) {
              console.warn("Failed to parse verification response, using safe patterns:", parseErr);
              verifiedPatterns = safePatterns;
            }
          } else {
            verifiedPatterns = safePatterns;
          }
        }
      }

      // Convert to LearnedPattern format
      const learnedPatterns: LearnedPattern[] = verifiedPatterns.map((p) => ({
        pattern: p.pattern,
        confidence: p.confidence,
        createdAt: now,
        sourceTransactionIds: transactionIds,
        ...(p.excludePatterns?.length ? { excludePatterns: p.excludePatterns } : {}),
      }));

      // 5. Update the partner with learned patterns (always overwrite)
      await partnerDoc.ref.update({
        learnedPatterns: learnedPatterns,
        patternsUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      console.log(`Learned ${learnedPatterns.length} patterns for partner ${partnerId}:`,
        learnedPatterns.map((p) => p.pattern));

      // 6. Cascade-unassign auto-matched transactions that no longer match
      // This is important when patterns change (e.g., manual assignment removed)
      const unassignedCount = await cascadeUnassignTransactions(userId, partnerId, learnedPatterns);
      if (unassignedCount > 0) {
        console.log(`Cascade-unassigned ${unassignedCount} transactions that no longer match updated patterns`);
      }

      // 8. Re-match unassigned transactions with the new patterns
      // IMPORTANT: Pass manualRemovalIds to prevent re-assigning transactions user explicitly removed
      const manualRemovalIds = new Set(manualRemovals.map((r) => r.transactionId));
      const { matchedCount: autoMatched, matchedTransactions } = await rematchUnassignedTransactions(
        userId,
        partnerId,
        partnerName,
        learnedPatterns,
        manualRemovalIds
      );
      console.log(`Auto-matched ${autoMatched} additional transactions with new patterns`);

      // 9. Create notification for pattern learning
      if (autoMatched > 0) {
        try {
          console.log(`Creating notification for user ${userId} - ${autoMatched} transactions matched`);
          const notifRef = await db.collection(`users/${userId}/notifications`).add({
            type: "pattern_learned",
            title: `Learned patterns for ${partnerName}`,
            message: `I learned ${learnedPatterns.length} pattern${learnedPatterns.length !== 1 ? "s" : ""} from your assignment and automatically matched ${autoMatched} similar transaction${autoMatched !== 1 ? "s" : ""} to ${partnerName}.`,
            createdAt: FieldValue.serverTimestamp(),
            readAt: null,
            context: {
              partnerId,
              partnerName,
              patternsLearned: learnedPatterns.length,
              transactionsMatched: autoMatched,
            },
            preview: {
              transactions: matchedTransactions,
            },
          });
          console.log(`Notification created: ${notifRef.id}`);
        } catch (err) {
          console.error("Failed to create pattern learning notification:", err);
        }
      }

      // 10. Chain file matching for partner
      // Always try file matching when patterns are learned or transactions are matched
      // This ensures files are auto-connected when a partner is manually assigned
      try {
        const { matchFilesForPartnerInternal } = await import("./matchFilesForPartner");
        const fileResult = await matchFilesForPartnerInternal(userId, partnerId);
        if (fileResult.autoMatched > 0 || fileResult.suggested > 0) {
          console.log(
            `File matching chained for ${partnerName}: ${fileResult.autoMatched} auto-matched, ${fileResult.suggested} suggested`
          );
        }
      } catch (err) {
        console.error("Failed to chain file matching:", err);
      }

      return {
        patternsLearned: learnedPatterns.length,
        patterns: learnedPatterns.map((p) => ({
          pattern: p.pattern,
          confidence: p.confidence,
        })),
      };
    } catch (error) {
      if (error instanceof HttpsError) throw error;

      console.error("Error learning partner patterns:", error);
      throw new HttpsError(
        "internal",
        `Pattern learning failed: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
);

// ============================================================================
// Batched Learning (for queue processing)
// ============================================================================

/**
 * Learn patterns for multiple partners in a single operation
 * Called by the learning queue processor
 */
export async function learnPatternsForPartnersBatch(
  userId: string,
  partnerIds: string[]
): Promise<void> {
  console.log(`Batch learning patterns for ${partnerIds.length} partners (user: ${userId})`);

  // Process each partner (could be parallelized for performance)
  for (const partnerId of partnerIds) {
    try {
      // Reuse the single partner learning logic
      // This is a simplified version - in production you'd want to batch the AI calls too
      const partnerDoc = await db.collection("partners").doc(partnerId).get();
      if (!partnerDoc.exists) {
        console.log(`Partner ${partnerId} not found, skipping`);
        continue;
      }

      const partnerData = partnerDoc.data()!;
      if (partnerData.userId !== userId) {
        console.log(`Partner ${partnerId} doesn't belong to user ${userId}, skipping`);
        continue;
      }

      // Fetch ONLY user-assigned transactions (not auto-assigned)
      // Includes: manual, suggestion (accepted), and ai (AI-assisted assignment)
      const assignedSnapshot = await db
        .collection("transactions")
        .where("userId", "==", userId)
        .where("partnerId", "==", partnerId)
        .where("partnerMatchedBy", "in", ["manual", "suggestion", "ai"])
        .limit(50)
        .get();

      // If no user assignments, clear patterns and cascade-unassign
      if (assignedSnapshot.empty) {
        console.log(`No user assignments for partner ${partnerId}, clearing patterns`);

        // Clear learned patterns
        await partnerDoc.ref.update({
          learnedPatterns: [],
          patternsUpdatedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        // Cascade-unassign all auto-assigned transactions
        await cascadeUnassignTransactions(userId, partnerId, []);
        continue;
      }

      const assignedTransactions = assignedSnapshot.docs.map((doc) => ({
        id: doc.id,
        partner: doc.data().partner || null,
        name: doc.data().name || "",
      }));

      // Get manual removals (false positives) from partner data
      const manualRemovals: ManualRemovalRecord[] = (partnerData.manualRemovals || []).map(
        (r: { transactionId: string; partner: string | null; name: string }) => ({
          transactionId: r.transactionId,
          partner: r.partner || null,
          name: r.name || "",
        })
      );

      // Fetch collision set
      const allAssignedSnapshot = await db
        .collection("transactions")
        .where("userId", "==", userId)
        .limit(500)
        .get();

      const currentGlobalPartnerId = partnerData.globalPartnerId || null;

      const partnerIds = new Set<string>();
      allAssignedSnapshot.docs.forEach((doc) => {
        const data = doc.data();
        const pid = data.partnerId;
        if (!pid || pid === partnerId) return;
        if (currentGlobalPartnerId && pid === currentGlobalPartnerId) return;
        if (data.partnerType === "global" && data.partnerMatchedBy !== "manual" && data.partnerMatchedBy !== "suggestion") {
          return;
        }
        partnerIds.add(pid);
      });

      const partnerNameMap = new Map<string, string>();
      if (partnerIds.size > 0) {
        const partnerDocs = await Promise.all(
          Array.from(partnerIds).slice(0, 50).map((pid) =>
            db.collection("partners").doc(pid).get()
          )
        );
        partnerDocs.forEach((doc) => {
          if (doc.exists) {
            partnerNameMap.set(doc.id, doc.data()!.name || "Unknown");
          }
        });
      }
      if (partnerIds.size > 0) {
        const globalDocs = await Promise.all(
          Array.from(partnerIds).slice(0, 50).map((pid) =>
            db.collection("globalPartners").doc(pid).get()
          )
        );
        globalDocs.forEach((doc) => {
          if (doc.exists) {
            partnerNameMap.set(doc.id, doc.data()!.name || "Unknown");
          }
        });
      }

      const collisionTransactions: CollisionTransaction[] = allAssignedSnapshot.docs
        .filter((doc) => {
          const data = doc.data();
          const pid = data.partnerId;
          if (!pid || pid === partnerId) return false;
          if (currentGlobalPartnerId && pid === currentGlobalPartnerId) return false;
          if (data.partnerType === "global" && data.partnerMatchedBy !== "manual" && data.partnerMatchedBy !== "suggestion") {
            return false;
          }
          return true;
        })
        .map((doc) => {
          const data = doc.data();
          return {
            partner: data.partner || null,
            name: data.name || "",
            assignedPartnerId: data.partnerId,
            assignedPartnerName: partnerNameMap.get(data.partnerId) || "Unknown",
          };
        });

      // Call Gemini to generate patterns
      const projectId = getProjectId();
      const vertexAI = new VertexAI({ project: projectId, location: VERTEX_LOCATION });
      const model = vertexAI.getGenerativeModel({ model: GEMINI_MODEL });

      const prompt = buildPrompt(
        partnerData.name,
        partnerData.aliases || [],
        assignedTransactions,
        collisionTransactions,
        manualRemovals
      );

      const response = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      });

      const responseData = response.response;

      // Log AI usage
      const usageMetadata = responseData.usageMetadata;
      await logAIUsage(userId, {
        function: "patternLearning",
        model: GEMINI_MODEL,
        inputTokens: usageMetadata?.promptTokenCount || 0,
        outputTokens: usageMetadata?.candidatesTokenCount || 0,
        metadata: { partnerId },
      });

      const text = responseData.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        console.log(`No text response for partner ${partnerId}, skipping`);
        continue;
      }

      let aiResult: AIPatternResponse;
      try {
        // Handle markdown code blocks
        let jsonText = text.trim();
        if (jsonText.startsWith("```json")) {
          jsonText = jsonText.slice(7);
        } else if (jsonText.startsWith("```")) {
          jsonText = jsonText.slice(3);
        }
        if (jsonText.endsWith("```")) {
          jsonText = jsonText.slice(0, -3);
        }
        aiResult = JSON.parse(jsonText.trim());
      } catch {
        console.error(`Failed to parse AI response for partner ${partnerId}`);
        continue;
      }

      if (!aiResult.patterns || !Array.isArray(aiResult.patterns)) {
        console.log(`No patterns returned for partner ${partnerId}`);
        continue;
      }

      // Validate and transform patterns
      const now = Timestamp.now();
      const transactionIds = assignedTransactions.map((tx) => tx.id);

      const matchesFalsePositive = (pattern: string): ManualRemovalRecord | null => {
        for (const tx of manualRemovals) {
          const textToMatch = [tx.name, tx.partner]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          if (textToMatch && globMatch(pattern, textToMatch)) {
            return tx;
          }
        }
        return null;
      };

      const learnedPatterns: LearnedPattern[] = aiResult.patterns
        .filter((p) => {
          if (!p.pattern || typeof p.pattern !== "string") return false;
          if (typeof p.confidence !== "number" || p.confidence < 50) return false;

          const normalizedPattern = p.pattern.toLowerCase().trim();

          // Check against false positives first
          const falsePositive = matchesFalsePositive(normalizedPattern);
          if (falsePositive) {
            console.log(`REJECTED pattern "${normalizedPattern}" for ${partnerData.name} - matches false positive: "${falsePositive.partner || falsePositive.name}"`);
            return false;
          }

          return true;
        })
        .map((p) => ({
          pattern: p.pattern.toLowerCase().trim(),
          confidence: Math.min(100, Math.max(0, Math.round(p.confidence))),
          createdAt: now,
          sourceTransactionIds: transactionIds,
          ...(p.excludePatterns?.length ? { excludePatterns: p.excludePatterns.map((ep: string) => ep.toLowerCase().trim()) } : {}),
        }));

      await partnerDoc.ref.update({
        learnedPatterns: learnedPatterns,
        patternsUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      console.log(`Learned ${learnedPatterns.length} patterns for ${partnerData.name}:`,
        learnedPatterns.map((p) => p.pattern));

      // Cascade-unassign auto-matched transactions that no longer match updated patterns
      const unassignedCount = await cascadeUnassignTransactions(userId, partnerId, learnedPatterns);
      if (unassignedCount > 0) {
        console.log(`[batch] Cascade-unassigned ${unassignedCount} transactions that no longer match updated patterns for ${partnerData.name}`);
      }

      // Apply patterns to unassigned transactions for this partner
      if (learnedPatterns.length > 0) {
        const manualRemovalIds = new Set(manualRemovals.map((r) => r.transactionId));
        const { matchedCount } = await rematchUnassignedTransactions(
          userId,
          partnerId,
          partnerData.name,
          learnedPatterns,
          manualRemovalIds
        );
        console.log(`Auto-matched ${matchedCount} transactions for ${partnerData.name}`);
      }
    } catch (error) {
      console.error(`Error learning patterns for partner ${partnerId}:`, error);
      // Continue with next partner
    }
  }
}
