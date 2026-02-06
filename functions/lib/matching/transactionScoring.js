"use strict";
/**
 * Shared Transaction Scoring Module
 *
 * Contains scoring logic used by:
 * - matchFileTransactions.ts (auto-triggered on file upload)
 * - findTransactionMatches.ts (callable for UI dialog)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCORING_CONFIG = void 0;
exports.normalizeIban = normalizeIban;
exports.normalizeName = normalizeName;
exports.namesMatch = namesMatch;
exports.calculateAmountScore = calculateAmountScore;
exports.calculateDateScore = calculateDateScore;
exports.calculateReferenceScore = calculateReferenceScore;
exports.calculatePartnerScore = calculatePartnerScore;
exports.scoreTransaction = scoreTransaction;
exports.formatScoreBreakdown = formatScoreBreakdown;
// === Configuration ===
exports.SCORING_CONFIG = {
    /** Minimum confidence for auto-matching (creates connection) */
    AUTO_MATCH_THRESHOLD: 85,
    /** Minimum confidence to show as suggestion */
    SUGGESTION_THRESHOLD: 50,
    /** Days to search before/after file date */
    DATE_RANGE_DAYS: 30,
    /** Max suggestions to store per file */
    MAX_SUGGESTIONS: 5,
    /** Max results to return from callable */
    MAX_RESULTS: 20,
};
// === Utility Functions ===
function normalizeIban(iban) {
    return iban.replace(/\s+/g, "").toUpperCase();
}
/**
 * Normalize a name for comparison (lowercase, remove common suffixes, trim)
 */
function normalizeName(name) {
    return name
        .toLowerCase()
        .replace(/\s*(gmbh|ag|kg|ohg|ug|\be\.?k\.?|inc\.?|ltd\.?|llc|co\.?)\s*/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}
/**
 * Check if two names match (fuzzy comparison)
 * Scoring rationale:
 * - Exact match = 25 pts (same as partner ID match - high trust)
 * - Contains match = 18 pts (e.g., "Amazon" vs "Amazon EU S.a.r.l.")
 * - Word overlap = 12-15 pts (partial confidence)
 */
function namesMatch(name1, name2) {
    const n1 = normalizeName(name1);
    const n2 = normalizeName(name2);
    // Exact match after normalization - treat as strong as partner ID match
    if (n1 === n2) {
        return { match: true, score: 25 };
    }
    // One contains the other (for partial matches like "Amazon" vs "Amazon EU S.a.r.l.")
    if (n1.includes(n2) || n2.includes(n1)) {
        return { match: true, score: 18 };
    }
    // Check for significant word overlap (at least 2 words match)
    const words1 = n1.split(" ").filter((w) => w.length > 2);
    const words2 = n2.split(" ").filter((w) => w.length > 2);
    const matchingWords = words1.filter((w) => words2.some((w2) => w === w2 || w.includes(w2) || w2.includes(w)));
    if (matchingWords.length >= 2) {
        return { match: true, score: 15 };
    }
    if (matchingWords.length >= 1 && (words1.length <= 2 || words2.length <= 2)) {
        return { match: true, score: 12 };
    }
    return { match: false, score: 0 };
}
// === Scoring Functions ===
function calculateAmountScore(fileAmount, txAmount, fileCurrency, txCurrency) {
    const absFile = Math.abs(fileAmount);
    const absTx = Math.abs(txAmount);
    if (absFile === 0 || absTx === 0) {
        return { score: 0, source: null, currencyMismatch: false };
    }
    // Check for currency mismatch
    // Normalize currencies for comparison (handle null/undefined/empty)
    const normFileCurrency = (fileCurrency || "EUR").toUpperCase();
    const normTxCurrency = (txCurrency || "EUR").toUpperCase();
    const currencyMismatch = normFileCurrency !== normTxCurrency;
    // Calculate base amount score
    let score = 0;
    let source = null;
    if (absFile === absTx) {
        score = 40;
        source = "amount_exact";
    }
    else {
        const difference = Math.abs(absFile - absTx);
        const tolerance = absFile;
        if (difference <= tolerance * 0.01) {
            score = 38;
            source = "amount_close";
        }
        else if (difference <= tolerance * 0.05) {
            score = 30;
            source = "amount_close";
        }
        else if (difference <= tolerance * 0.1) {
            score = 20;
            source = "amount_close";
        }
    }
    // Apply currency mismatch penalty: reduce amount score by 50%
    // This allows USD invoice to still match EUR transaction (with exchange rate variance)
    // but prioritizes same-currency matches
    if (currencyMismatch && score > 0) {
        score = Math.round(score * 0.5);
    }
    return { score, source, currencyMismatch };
}
function calculateDateScore(fileDate, txDate, billingCycle) {
    const daysDiff = Math.abs(Math.floor((fileDate.getTime() - txDate.getTime()) / (1000 * 60 * 60 * 24)));
    // If billing cycle has a learned invoice-to-transaction delay, check against it
    // This handles cases like "Telekom invoice Dec 1 → bank debit Dec 15" where
    // daysDiff=14 normally scores 8, but the learned delay makes it a strong match
    if (billingCycle?.invoiceToTransactionDelay != null) {
        const expectedDelay = billingCycle.invoiceToTransactionDelay;
        const variance = billingCycle.delayVariance ?? 3;
        const actualDelay = Math.floor((txDate.getTime() - fileDate.getTime()) / (1000 * 60 * 60 * 24));
        const delayDiff = Math.abs(actualDelay - expectedDelay);
        if (delayDiff <= variance)
            return { score: 25, source: "date_exact" };
        if (delayDiff <= variance * 2)
            return { score: 22, source: "date_close" };
    }
    // Standard date proximity scoring
    if (daysDiff === 0)
        return { score: 25, source: "date_exact" };
    if (daysDiff <= 3)
        return { score: 22, source: "date_close" };
    if (daysDiff <= 7)
        return { score: 15, source: "date_close" };
    if (daysDiff <= 14)
        return { score: 8, source: "date_close" };
    if (daysDiff <= 30)
        return { score: 3, source: "date_close" };
    return { score: 0, source: null };
}
function calculateReferenceScore(extractedText, reference, currentDateScore) {
    if (!reference || reference.length < 3) {
        return { score: 0, dateBonus: 0, source: null };
    }
    const normalizedText = extractedText.toLowerCase();
    const normalizedRef = reference.toLowerCase();
    if (normalizedText.includes(normalizedRef)) {
        const dateBonus = currentDateScore < 15 ? 10 : 0;
        return { score: 5, dateBonus, source: "reference" };
    }
    return { score: 0, dateBonus: 0, source: null };
}
/**
 * Calculate partner score with multiple matching strategies:
 * 1. Partner ID match (strongest signal)
 * 2. Partner text match (file's extractedPartner vs transaction's name/partner)
 * 3. Partner alias match (check if transaction name matches any alias of file's assigned partner)
 */
function calculatePartnerScore(fileData, txData, partnerAliases) {
    // 1. Direct partner ID match (strongest - both have partnerId assigned)
    if (fileData.partnerId &&
        txData.partnerId &&
        fileData.partnerId === txData.partnerId) {
        return { score: 25, source: "partner" };
    }
    // Get transaction's text name (could be in 'name', 'partner', or 'partnerName' field)
    const txName = txData.name || txData.partner || txData.partnerName || "";
    if (!txName) {
        return { score: 0, source: null };
    }
    // 2. Check file's extracted partner text against transaction name
    if (fileData.extractedPartner) {
        const result = namesMatch(fileData.extractedPartner, txName);
        if (result.match) {
            return { score: result.score, source: "partner" };
        }
    }
    // 3. Check partner aliases against transaction name
    if (partnerAliases && partnerAliases.length > 0) {
        for (const alias of partnerAliases) {
            const result = namesMatch(alias, txName);
            if (result.match) {
                return { score: result.score, source: "partner" };
            }
        }
    }
    return { score: 0, source: null };
}
/**
 * Score a transaction against file data
 */
function scoreTransaction(fileData, txData, partnerAliases, options) {
    let amountScore = 0;
    let dateScore = 0;
    let partnerScore = 0;
    let ibanScore = 0;
    let referenceScore = 0;
    let hintScore = 0;
    const matchSources = [];
    // 1. Amount scoring (0-40, reduced if currency mismatch)
    if (fileData.extractedAmount != null) {
        const result = calculateAmountScore(fileData.extractedAmount, txData.amount, fileData.extractedCurrency, txData.currency);
        amountScore = result.score;
        if (result.source)
            matchSources.push(result.source);
    }
    // 2. Date scoring (0-25, boosted when partner matches)
    if (fileData.extractedDate) {
        const result = calculateDateScore(fileData.extractedDate.toDate(), txData.date.toDate(), options?.billingCycle);
        dateScore = result.score;
        if (result.source)
            matchSources.push(result.source);
    }
    // 3. Partner scoring (0-25 for ID match, 0-15 for text match)
    const partnerResult = calculatePartnerScore(fileData, txData, partnerAliases);
    partnerScore = partnerResult.score;
    if (partnerResult.source)
        matchSources.push(partnerResult.source);
    // 3b. Date boost for partner matches (recurring transaction disambiguation)
    // When partner matches, date becomes critical for distinguishing monthly invoices.
    // Boost date score by 50% (max +12.5 pts) to prioritize correct month matching.
    // Also apply a date penalty when date is poor but partner matches - this prevents
    // a wrong-month transaction from scoring high just because partner/amount match.
    if (partnerScore >= 15 && fileData.extractedDate) {
        if (dateScore >= 15) {
            // Good date match + partner match: boost date by 50%
            dateScore = Math.min(37, Math.round(dateScore * 1.5));
        }
        else if (dateScore <= 3) {
            // Poor date match + partner match: likely wrong month, apply penalty
            // Reduce partner score to discourage matching wrong-month transactions
            partnerScore = Math.round(partnerScore * 0.6);
        }
    }
    // 4. IBAN scoring (0-10)
    if (fileData.extractedIban && txData.partnerIban) {
        const fileIban = normalizeIban(fileData.extractedIban);
        const txIban = normalizeIban(txData.partnerIban);
        if (fileIban === txIban) {
            ibanScore = 10;
            matchSources.push("iban");
        }
    }
    // 5. Reference scoring (0-5, with date bonus)
    if (fileData.extractedText && txData.reference) {
        const result = calculateReferenceScore(fileData.extractedText, txData.reference, dateScore);
        referenceScore = result.score;
        if (result.dateBonus) {
            dateScore = Math.min(25, dateScore + result.dateBonus);
        }
        if (result.source)
            matchSources.push(result.source);
    }
    // 6. Precision search hint scoring (0-40)
    if (fileData.precisionSearchHint &&
        fileData.precisionSearchHint.transactionId === txData.id) {
        const searchConfidence = fileData.precisionSearchHint.matchConfidence;
        if (searchConfidence && searchConfidence >= 50) {
            hintScore = 40;
        }
        else if (searchConfidence && searchConfidence >= 25) {
            hintScore = 30;
        }
        else {
            hintScore = 25;
        }
        matchSources.push("precision_hint");
    }
    // Apply per-partner weight adjustments if provided
    const w = options?.weights;
    const weightedAmount = w ? amountScore * w.amountWeight : amountScore;
    const weightedDate = w ? dateScore * w.dateWeight : dateScore;
    const weightedPartner = w ? partnerScore * w.partnerWeight : partnerScore;
    const rawConfidence = weightedAmount + weightedDate + weightedPartner + ibanScore + referenceScore + hintScore;
    // Cap at 100 (multiple strong signals shouldn't exceed 100%)
    const confidence = Math.min(100, Math.round(rawConfidence));
    return {
        transactionId: txData.id,
        confidence,
        matchSources,
        breakdown: {
            amount: amountScore,
            date: dateScore,
            partner: partnerScore,
            iban: ibanScore,
            reference: referenceScore,
            hint: hintScore,
        },
        preview: {
            date: txData.date,
            amount: txData.amount,
            currency: txData.currency || "EUR",
            name: txData.name || "",
            partner: txData.partner || null,
        },
    };
}
/**
 * Format score breakdown for logging
 */
function formatScoreBreakdown(breakdown) {
    const parts = [];
    if (breakdown.amount > 0)
        parts.push(`amt:${breakdown.amount}`);
    if (breakdown.date > 0)
        parts.push(`date:${breakdown.date}`);
    if (breakdown.partner > 0)
        parts.push(`partner:${breakdown.partner}`);
    if (breakdown.iban > 0)
        parts.push(`iban:${breakdown.iban}`);
    if (breakdown.reference > 0)
        parts.push(`ref:${breakdown.reference}`);
    if (breakdown.hint > 0)
        parts.push(`hint:${breakdown.hint}`);
    return parts.join(" + ");
}
//# sourceMappingURL=transactionScoring.js.map