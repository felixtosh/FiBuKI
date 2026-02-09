/**
 * Shared Pattern Learning Engine
 *
 * Stateless, reusable pattern learning pipeline used by both
 * partner pattern learning and category pattern learning.
 *
 * Pipeline: generate → dry-run → verify → coverage retry → return
 */

import { matchPatternFlexible } from "../utils/pattern-utils";
import type { GenerativeModel } from "@google-cloud/vertexai";

// ============================================================================
// Types
// ============================================================================

export interface TxSample {
  id: string;
  partner: string | null;
  name: string;
  reference: string | null;
}

export interface CollisionTxSample extends TxSample {
  assignedToName: string;
}

export interface PatternLearningInput {
  /** Display name for prompts (e.g., "Amazon" or "Amazon → Office Supplies") */
  targetName: string;
  /** Known aliases for the target */
  targetAliases: string[];

  /** Transactions that MUST match (user-assigned) */
  positiveTransactions: TxSample[];
  /** Transactions that MUST NOT match (false positives / manual removals) */
  negativeTransactions: TxSample[];
  /** Transactions assigned to OTHER targets that MUST NOT match */
  collisionTransactions: CollisionTxSample[];

  /** All user transactions for dry-run testing */
  allUserTransactions: TxSample[];
  /** Total transaction count (may exceed allUserTransactions due to limits) */
  totalTransactionCount: number;

  /** Gemini model instance (caller creates it) */
  model: GenerativeModel;

  /**
   * Optional: ID to exclude from collision detection during dry-run.
   * For partner learning, this is the partnerId (so own txs aren't "conflicts").
   * For category learning, not needed since collisions are pre-filtered.
   */
  ownerId?: string;
  /**
   * Optional: map of owner IDs to names for conflict display.
   * For partner learning: partnerId → partnerName.
   */
  ownerNameMap?: Map<string, string>;
}

export interface VerifiedPattern {
  pattern: string;
  confidence: number;
  excludePatterns?: string[];
}

export interface PatternLearningResult {
  patterns: VerifiedPattern[];
  aiUsage: { inputTokens: number; outputTokens: number; calls: number };
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

interface DryRunMatch {
  id: string;
  name: string;
  partner: string | null;
  reference: string | null;
  isAssignedToOther: boolean;
  otherName?: string;
}

// ============================================================================
// Known Generic Banking Terms (context for AI, not auto-reject)
// ============================================================================

const GENERIC_BANKING_TERMS_DE = [
  "rechnung", "rechner", "rechn", "ueberweisung", "überweisung",
  "lastschrift", "gutschrift", "zahlung", "bezahlung", "abbuchung",
  "einzahlung", "auszahlung", "konto", "sepa", "mandat",
  "referenz", "verwendung", "betrag", "iban", "bic", "nr",
];

const GENERIC_BANKING_TERMS_EN = [
  "transfer", "payment", "card", "direct", "debit", "credit",
  "deposit", "withdrawal", "refund", "purchase", "transaction",
  "topup", "top-up", "top up", "payout", "cashback", "fee",
  "interest", "exchange",
];

// ============================================================================
// Formatting Helpers
// ============================================================================

export function formatTxFields(tx: { partner: string | null; name: string; reference?: string | null }): string {
  let line = `partner: "${tx.partner || "(empty)"}" | name: "${tx.name}"`;
  if (tx.reference) line += ` | reference: "${tx.reference}"`;
  return line;
}

// ============================================================================
// Prompt Builders
// ============================================================================

function buildGenerationPrompt(input: PatternLearningInput): string {
  const { targetName, targetAliases, positiveTransactions, negativeTransactions, collisionTransactions } = input;

  const assignedList = positiveTransactions
    .map((tx) => `- ${formatTxFields(tx)}`)
    .join("\n");

  const removalsList = negativeTransactions
    .slice(0, 20)
    .map((tx) => `- ${formatTxFields(tx)}`)
    .join("\n");

  const collisionList = collisionTransactions
    .slice(0, 30)
    .map((tx) => `- ${formatTxFields(tx)} → assigned to: ${tx.assignedToName}`)
    .join("\n");

  return `You are analyzing bank transaction data to learn matching patterns for "${targetName}".

## Target Information
Name: ${targetName}
Existing Aliases: ${targetAliases.length > 0 ? targetAliases.join(", ") : "(none)"}

## MUST MATCH - Transactions assigned to this target
Your patterns MUST match ALL of these:
${assignedList || "(no transactions yet)"}

## MUST NOT MATCH - FALSE POSITIVES (user explicitly removed these)
These transactions were auto-matched but the user said they are WRONG. Your patterns MUST NOT match any of these:
${removalsList || "(none)"}

## MUST NOT MATCH - Transactions assigned to OTHER targets
Your patterns must NOT match ANY of these (collision check):
${collisionList || "(no other assigned transactions)"}

## Instructions

Generate glob-style patterns that will match future transactions for "${targetName}".

IMPORTANT: Prefer GENERAL patterns over specific ones!
- If all transactions start with "Google", use "google*" not "google*cloud*", "google*ads*" separately
- Only be specific when necessary to avoid collisions with other targets
- Simpler patterns = better (easier to match future variations)

Pattern Rules:
1. Use * as a wildcard (matches any characters, including spaces)
2. Patterns are matched against each field INDIVIDUALLY (partner, name, reference) and combined
3. Patterns must match ALL "must match" transactions (via at least one field)
4. Patterns must NOT match ANY "must not match" transactions
5. Prefer shorter, more general patterns when safe
6. CRITICAL: Handle spelling variations by using * between word parts!
   - "Media Markt" and "Mediamarkt" → use "*media*markt*" (not "*media markt*")
   - Spaces and no-spaces are different! Use * to match both
7. Common pattern examples:
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
      "reasoning": "All Google transactions start with 'google' and no collisions with other targets",
      "excludePatterns": ["*cloud*", "*workspace*"]
    }
  ]
}

Notes on excludePatterns:
- Use excludePatterns to EXCLUDE specific transactions that would otherwise match
- Derived from the FALSE POSITIVES list (user explicitly said these are NOT this target)
- Example: If "*paypal*" matches both PayPal payments and "PayPal *foodora", but user removed "PayPal *foodora", add excludePatterns: ["*foodora*"]
- Only include excludePatterns if there are false positives that need explicit exclusion
- excludePatterns is optional - omit if not needed

If no good patterns can be learned (e.g., only 1 transaction with no clear pattern), return:
{"patterns": []}`;
}

function buildVerificationPrompt(
  targetName: string,
  proposedPatterns: Array<{ pattern: string; confidence: number; excludePatterns?: string[] }>,
  dryRunResults: Map<string, DryRunMatch[]>,
  totalTransactions: number,
  positiveTransactions: TxSample[]
): string {
  const assignedSection = positiveTransactions.length > 0
    ? `## Source: User-assigned transactions for "${targetName}"
${positiveTransactions.map((tx) => `- ${formatTxFields(tx)}`).join("\n")}
`
    : "";

  const sections = proposedPatterns.map((p) => {
    const matches = dryRunResults.get(p.pattern) || [];
    const unassigned = matches.filter((m) => !m.isAssignedToOther);
    const conflicts = matches.filter((m) => m.isAssignedToOther);

    const matchPercent = totalTransactions ? ((matches.length / totalTransactions) * 100).toFixed(1) : null;
    const isBroad = matches.length > 20 || (matchPercent && parseFloat(matchPercent) > 3);

    const excludeInfo = p.excludePatterns?.length
      ? `\nExclude patterns: ${p.excludePatterns.map((e) => `"${e}"`).join(", ")}`
      : "";

    return `## Pattern: "${p.pattern}" (proposed confidence: ${p.confidence}%)${excludeInfo}

⚠️ MATCH STATISTICS: Would match ${matches.length} transactions${matchPercent ? ` (${matchPercent}% of all ${totalTransactions})` : ""}${isBroad ? " - THIS IS A LOT, BE CAREFUL!" : ""}

${unassigned.length > 0 ? `UNASSIGNED (will be auto-assigned to ${targetName}):
${unassigned.slice(0, 15).map((m) => `- ${formatTxFields(m)}`).join("\n")}
${unassigned.length > 15 ? `... and ${unassigned.length - 15} more (REVIEW CAREFULLY - too many matches is suspicious!)` : ""}` : "(none unassigned)"}

${conflicts.length > 0 ? `CONFLICTS (already assigned to OTHER targets):
${conflicts.slice(0, 5).map((m) => `- ${formatTxFields(m)} → currently: ${m.otherName}`).join("\n")}
${conflicts.length > 5 ? `... and ${conflicts.length - 5} more conflicts` : ""}` : "(no conflicts)"}`;
  });

  return `You are VERIFYING patterns for "${targetName}".

${assignedSection}Below are proposed patterns and what transactions they WOULD match if applied.
Review each pattern and decide whether to APPROVE or REJECT it.

## Known generic banking terms (for your awareness, use your judgment)
German: ${GENERIC_BANKING_TERMS_DE.join(", ")}
English: ${GENERIC_BANKING_TERMS_EN.join(", ")}
These are NOT auto-rejected — use the dry-run data below to decide.
A pattern that is ONLY generic terms (e.g., "*rechnung*", "*payment*") is almost always wrong.
But a pattern combining a specific name WITH a generic term (e.g., "*amazon*rechnung*") may be fine.

${sections.join("\n\n")}

## Instructions
For each pattern, verify:
1. Do ALL the matched transactions clearly belong to "${targetName}"?
2. Is the pattern SPECIFIC enough? (Generic patterns like "*transfer*", "*rechnung*", "*payment*" are WRONG)
3. Are there any false positives (transactions that shouldn't match)?
4. Does the match count seem reasonable? (>20 matches is suspicious unless all clearly belong to this target)

REJECT patterns that:
- Match only generic banking terms (transfer, payment, card, rechnung, überweisung, zahlung, lastschrift)
- Match too many transactions (>20 is suspicious unless all clearly belong to this target)
- Have ANY conflicts with other targets
- Rely on exclude patterns to be safe (fragile — new targets won't be excluded)
- Could plausibly match future unrelated transactions

Respond ONLY with valid JSON:
{
  "verified": [
    {"pattern": "google*", "approved": true, "adjustedConfidence": 95},
    {"pattern": "*transfer", "approved": false, "reason": "too generic - matches any bank transfer"}
  ]
}`;
}

// ============================================================================
// Dry-Run Pattern Match
// ============================================================================

function dryRunPatterns(
  proposedPatterns: Array<{ pattern: string; confidence: number }>,
  allTransactions: TxSample[],
  ownerId: string | undefined,
  ownerNameMap: Map<string, string> | undefined
): Map<string, DryRunMatch[]> {
  const results = new Map<string, DryRunMatch[]>();

  for (const pattern of proposedPatterns) {
    const matches: DryRunMatch[] = [];

    for (const tx of allTransactions) {
      if (matchPatternFlexible(pattern.pattern.toLowerCase(), tx.name || null, tx.partner, tx.reference)) {
        // Determine if assigned to "other" based on ownerId
        // The caller provides ownerId so we can distinguish own vs other assignments
        const txAny = tx as TxSample & { assignedOwnerId?: string };
        const assignedOwnerId = txAny.assignedOwnerId;
        const isAssignedToOther = ownerId
          ? (!!assignedOwnerId && assignedOwnerId !== ownerId)
          : false;

        matches.push({
          id: tx.id,
          name: tx.name || "",
          partner: tx.partner,
          reference: tx.reference,
          isAssignedToOther,
          otherName: isAssignedToOther && ownerNameMap
            ? ownerNameMap.get(assignedOwnerId!) || "Unknown"
            : undefined,
        });
      }
    }

    results.set(pattern.pattern, matches);
  }

  return results;
}

// ============================================================================
// Safety Net (catastrophic only)
// ============================================================================

/**
 * Minimal safety net: only rejects patterns matching >50% of all transactions.
 * This catches truly catastrophic patterns that the AI might miss.
 * All nuanced decisions are left to the AI verification step.
 */
function checkCatastrophicSafety(
  pattern: string,
  matchCount: number,
  totalTransactions: number,
  sourceTransactionCount: number
): { rejected: boolean; reason?: string } {
  if (totalTransactions > 0 && matchCount > 0) {
    const matchPercent = (matchCount / totalTransactions) * 100;
    const sourceRatio = sourceTransactionCount / matchCount;
    if (matchPercent > 50 && sourceRatio < 0.3) {
      return {
        rejected: true,
        reason: `Pattern "${pattern}" matches ${matchCount}/${totalTransactions} (${matchPercent.toFixed(0)}%) transactions — catastrophically broad`,
      };
    }
  }
  return { rejected: false };
}

// ============================================================================
// JSON Parsing Helper
// ============================================================================

function parseJsonResponse(text: string): unknown {
  let jsonText = text.trim();
  if (jsonText.startsWith("```json")) jsonText = jsonText.slice(7);
  else if (jsonText.startsWith("```")) jsonText = jsonText.slice(3);
  if (jsonText.endsWith("```")) jsonText = jsonText.slice(0, -3);
  return JSON.parse(jsonText.trim());
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Shared pattern learning pipeline.
 *
 * 1. Generate patterns via Gemini
 * 2. Dry-run patterns against all transactions
 * 3. Catastrophic safety check (>50% match)
 * 4. Verify patterns via Gemini self-criticism with dry-run evidence
 * 5. Coverage retry if patterns miss assigned transactions
 *
 * Returns verified patterns and AI usage stats.
 * Caller handles: storage, cascade unassign, rematch, notifications.
 */
export async function learnPatterns(input: PatternLearningInput): Promise<PatternLearningResult> {
  const {
    targetName, positiveTransactions, negativeTransactions,
    collisionTransactions, allUserTransactions, totalTransactionCount,
    model, ownerId, ownerNameMap,
  } = input;

  const aiUsage = { inputTokens: 0, outputTokens: 0, calls: 0 };

  function trackUsage(response: { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }) {
    aiUsage.inputTokens += response.usageMetadata?.promptTokenCount || 0;
    aiUsage.outputTokens += response.usageMetadata?.candidatesTokenCount || 0;
    aiUsage.calls++;
  }

  // ── Step 1: Generate patterns ──────────────────────────────────────────
  const prompt = buildGenerationPrompt(input);
  const response = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });
  trackUsage(response.response);

  const text = response.response.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    console.log(`[PatternEngine] No text response from AI for "${targetName}"`);
    return { patterns: [], aiUsage };
  }

  let aiResult: AIPatternResponse;
  try {
    aiResult = parseJsonResponse(text) as AIPatternResponse;
  } catch {
    console.error(`[PatternEngine] Failed to parse AI response for "${targetName}":`, text);
    return { patterns: [], aiUsage };
  }

  if (!aiResult.patterns || !Array.isArray(aiResult.patterns) || aiResult.patterns.length === 0) {
    console.log(`[PatternEngine] AI returned no patterns for "${targetName}"`);
    return { patterns: [], aiUsage };
  }

  // ── Step 1b: Pre-filter (basic validation + false-positive check) ──────
  const candidatePatterns = aiResult.patterns
    .filter((p) => {
      if (!p.pattern || typeof p.pattern !== "string") return false;
      if (typeof p.confidence !== "number" || p.confidence < 50) return false;

      const normalizedPattern = p.pattern.toLowerCase().trim();

      // Check against false positives (manual removals)
      for (const tx of negativeTransactions) {
        if (matchPatternFlexible(normalizedPattern, tx.name || null, tx.partner, tx.reference)) {
          console.log(`[PatternEngine] REJECTED pattern "${normalizedPattern}" - matches false positive: "${tx.partner || tx.name}"`);
          return false;
        }
      }
      return true;
    })
    .map((p) => ({
      pattern: p.pattern.toLowerCase().trim(),
      confidence: Math.min(100, Math.max(0, Math.round(p.confidence))),
      ...(p.excludePatterns?.length ? { excludePatterns: p.excludePatterns.map((e) => e.toLowerCase().trim()) } : {}),
    }));

  if (candidatePatterns.length === 0) {
    console.log(`[PatternEngine] All patterns rejected in pre-filter for "${targetName}"`);
    return { patterns: [], aiUsage };
  }

  // ── Step 2: Dry-run ────────────────────────────────────────────────────
  console.log(`[PatternEngine] Running dry-run for ${candidatePatterns.length} candidate patterns`);
  const dryRunResults = dryRunPatterns(candidatePatterns, allUserTransactions, ownerId, ownerNameMap);

  // ── Step 3: Catastrophic safety check ──────────────────────────────────
  const safePatterns: typeof candidatePatterns = [];
  for (const cp of candidatePatterns) {
    const matches = dryRunResults.get(cp.pattern) || [];
    const safety = checkCatastrophicSafety(
      cp.pattern,
      matches.length,
      totalTransactionCount,
      positiveTransactions.length
    );

    if (safety.rejected) {
      console.log(`[PatternEngine] CATASTROPHIC SAFETY REJECTED "${cp.pattern}": ${safety.reason}`);
      dryRunResults.delete(cp.pattern);
    } else {
      safePatterns.push(cp);
    }
  }

  if (safePatterns.length === 0) {
    console.log(`[PatternEngine] All patterns rejected by safety checks for "${targetName}"`);
    return { patterns: [], aiUsage };
  }

  // Log dry-run results
  for (const [pattern, matches] of dryRunResults) {
    const conflicts = matches.filter((m) => m.isAssignedToOther);
    console.log(`[PatternEngine]   Pattern "${pattern}": ${matches.length} matches, ${conflicts.length} conflicts`);
  }

  // ── Step 4: AI Verification ────────────────────────────────────────────
  const verifyPrompt = buildVerificationPrompt(
    targetName,
    safePatterns,
    dryRunResults,
    totalTransactionCount,
    positiveTransactions
  );

  const verifyResponse = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: verifyPrompt }] }],
  });
  trackUsage(verifyResponse.response);

  let verifiedPatterns = safePatterns;

  const verifyText = verifyResponse.response.candidates?.[0]?.content?.parts?.[0]?.text;
  if (verifyText) {
    try {
      const verifyResult = parseJsonResponse(verifyText) as AIVerificationResponse;

      verifiedPatterns = safePatterns.filter((cp) => {
        const verification = verifyResult.verified?.find((v) => v.pattern === cp.pattern);
        if (!verification) return true; // Keep if not mentioned
        if (!verification.approved) {
          console.log(`[PatternEngine] VERIFICATION REJECTED "${cp.pattern}": ${verification.reason || "no reason"}`);
          return false;
        }
        if (verification.adjustedConfidence !== undefined) {
          cp.confidence = verification.adjustedConfidence;
        }
        return true;
      });

      console.log(`[PatternEngine] Verification: ${safePatterns.length} → ${verifiedPatterns.length} approved`);
    } catch (parseErr) {
      console.warn("[PatternEngine] Failed to parse verification response, using safe patterns:", parseErr);
      verifiedPatterns = safePatterns;
    }
  }

  // ── Step 5: Coverage retry ─────────────────────────────────────────────
  if (verifiedPatterns.length > 0 && positiveTransactions.length > 1) {
    const uncoveredTxs = positiveTransactions.filter((tx) =>
      !verifiedPatterns.some((p) =>
        matchPatternFlexible(p.pattern, tx.name || null, tx.partner, tx.reference)
      )
    );

    if (uncoveredTxs.length > 0) {
      console.log(
        `[PatternEngine] Coverage gap: ${uncoveredTxs.length}/${positiveTransactions.length} assigned txs not matched. Retrying...`
      );

      const coveragePrompt = `You previously generated these glob patterns for "${targetName}":
${verifiedPatterns.map((p) => `- "${p.pattern}" (${p.confidence}%)`).join("\n")}

But these assigned transactions are NOT matched by any of those patterns:
${uncoveredTxs.map((tx) => `- ${formatTxFields(tx)}`).join("\n")}

Patterns are tested against each field individually (partner, name, reference) and combined.
CRITICAL: "FREE NOW" (with space) does NOT match "*freenow*" — use "*free*now*" to handle both.

Generate ADDITIONAL patterns to cover the unmatched transactions.
Same rules: use * wildcards, prefer general patterns, avoid collisions.

${collisionTransactions.length > 0 ? `MUST NOT match these (other targets):\n${collisionTransactions.slice(0, 15).map((tx) => `- ${formatTxFields(tx)} → ${tx.assignedToName}`).join("\n")}` : ""}

Respond ONLY with valid JSON:
{"patterns": [{"pattern": "...", "confidence": 95, "reasoning": "..."}]}
If no additional patterns needed: {"patterns": []}`;

      try {
        const retryResponse = await model.generateContent({
          contents: [{ role: "user", parts: [{ text: coveragePrompt }] }],
        });
        trackUsage(retryResponse.response);

        const retryText = retryResponse.response.candidates?.[0]?.content?.parts?.[0]?.text;
        if (retryText) {
          const retryResult = parseJsonResponse(retryText) as AIPatternResponse;
          if (retryResult.patterns?.length) {
            const additionalPatterns = retryResult.patterns
              .filter((p) => p.pattern && typeof p.pattern === "string" && p.confidence >= 50)
              .map((p) => ({
                pattern: p.pattern.toLowerCase().trim(),
                confidence: Math.min(100, Math.max(0, Math.round(p.confidence))),
                ...(p.excludePatterns?.length ? { excludePatterns: p.excludePatterns.map((e) => e.toLowerCase().trim()) } : {}),
              }))
              .filter((p) =>
                uncoveredTxs.some((tx) =>
                  matchPatternFlexible(p.pattern, tx.name || null, tx.partner, tx.reference)
                )
              );

            if (additionalPatterns.length > 0) {
              console.log(`[PatternEngine] Coverage retry added ${additionalPatterns.length} patterns: ${additionalPatterns.map((p) => p.pattern)}`);
              verifiedPatterns = [...verifiedPatterns, ...additionalPatterns];
            }
          }
        }
      } catch (retryErr) {
        console.warn("[PatternEngine] Coverage retry failed, continuing with existing patterns:", retryErr);
      }
    }
  }

  return { patterns: verifiedPatterns, aiUsage };
}
