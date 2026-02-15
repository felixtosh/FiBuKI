"use strict";
/**
 * Server-side partner matching utilities
 * Mirrors the client-side matching logic for Cloud Functions
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchPatternFlexible = exports.globMatch = void 0;
exports.colognePhonetic = colognePhonetic;
exports.normalizeUrl = normalizeUrl;
exports.normalizeIban = normalizeIban;
exports.normalizeCompanyName = normalizeCompanyName;
exports.calculateCompanyNameSimilarity = calculateCompanyNameSimilarity;
exports.matchTransaction = matchTransaction;
exports.shouldAutoApply = shouldAutoApply;
// Import from pattern-utils for local use
const pattern_utils_1 = require("./pattern-utils");
// Re-export for backwards compatibility
var pattern_utils_2 = require("./pattern-utils");
Object.defineProperty(exports, "globMatch", { enumerable: true, get: function () { return pattern_utils_2.globMatch; } });
Object.defineProperty(exports, "matchPatternFlexible", { enumerable: true, get: function () { return pattern_utils_2.matchPatternFlexible; } });
// ============ Cologne Phonetics ============
/**
 * Cologne Phonetics (Kölner Phonetik) implementation
 * A phonetic algorithm optimized for German but works reasonably for other languages.
 * Similar words sound alike and produce the same phonetic code.
 */
function colognePhonetic(str) {
    if (!str)
        return "";
    // Normalize: lowercase, remove non-letters, handle umlauts
    let s = str.toLowerCase()
        .replace(/ä/g, "a")
        .replace(/ö/g, "o")
        .replace(/ü/g, "u")
        .replace(/ß/g, "ss")
        .replace(/[^a-z]/g, "");
    if (s.length === 0)
        return "";
    const codes = [];
    for (let i = 0; i < s.length; i++) {
        const char = s[i];
        const prev = i > 0 ? s[i - 1] : "";
        const next = i < s.length - 1 ? s[i + 1] : "";
        let code;
        switch (char) {
            case "a":
            case "e":
            case "i":
            case "o":
            case "u":
                code = "0";
                break;
            case "h":
                code = "";
                break;
            case "b":
                code = "1";
                break;
            case "p":
                code = next === "h" ? "3" : "1";
                break;
            case "d":
            case "t":
                code = ["c", "s", "z"].includes(next) ? "8" : "2";
                break;
            case "f":
            case "v":
            case "w":
                code = "3";
                break;
            case "g":
            case "k":
            case "q":
                code = "4";
                break;
            case "c":
                if (i === 0) {
                    code = ["a", "h", "k", "l", "o", "q", "r", "u", "x"].includes(next) ? "4" : "8";
                }
                else {
                    code = ["a", "h", "k", "o", "q", "u", "x"].includes(next) &&
                        !["s", "z"].includes(prev) ? "4" : "8";
                }
                break;
            case "x":
                code = ["c", "k", "q"].includes(prev) ? "8" : "48";
                break;
            case "l":
                code = "5";
                break;
            case "m":
            case "n":
                code = "6";
                break;
            case "r":
                code = "7";
                break;
            case "s":
            case "z":
                code = "8";
                break;
            case "j":
                code = "0";
                break;
            case "y":
                code = "0";
                break;
            default:
                code = "";
        }
        codes.push(code);
    }
    let result = "";
    let lastCode = "";
    for (const code of codes) {
        for (const c of code) {
            if (c !== lastCode) {
                result += c;
                lastCode = c;
            }
        }
    }
    const withoutZeros = result.replace(/0/g, "");
    return withoutZeros || "0";
}
// ============ URL Normalization ============
function normalizeUrl(url) {
    if (!url)
        return "";
    try {
        let normalized = url.toLowerCase().trim();
        normalized = normalized.replace(/^https?:\/\//, "");
        normalized = normalized.replace(/^www\./, "");
        normalized = normalized.replace(/\/$/, "");
        normalized = normalized.split("?")[0].split("#")[0];
        return normalized;
    }
    catch {
        return url.toLowerCase().trim();
    }
}
// ============ IBAN Normalization ============
function normalizeIban(iban) {
    return iban.replace(/\s+/g, "").toUpperCase();
}
// ============ Company Name Normalization ============
const COMPANY_SUFFIXES = [
    /\s*gmbh\s*$/i,
    /\s*g\.m\.b\.h\.\s*$/i,
    /\s*ges\.?m\.?b\.?h\.?\s*$/i,
    /\s*ag\s*$/i,
    /\s*kg\s*$/i,
    /\s*ohg\s*$/i,
    /\s*og\s*$/i,
    /\s*e\.?u\.?\s*$/i,
    /\s*&\s*co\.?\s*(kg|ohg)?\s*$/i,
    /\s*mbh\s*$/i,
    /\s*ltd\.?\s*$/i,
    /\s*limited\s*$/i,
    /\s*inc\.?\s*$/i,
    /\s*incorporated\s*$/i,
    /\s*corp\.?\s*$/i,
    /\s*corporation\s*$/i,
    /\s*llc\s*$/i,
    /\s*llp\s*$/i,
    /\s*plc\s*$/i,
    /\s*co\.?\s*$/i,
    /\s*s\.?a\.?\s*$/i,
    /\s*s\.?a\.?r\.?l\.?\s*$/i,
    /\s*sarl\s*$/i,
    /\s*sas\s*$/i,
    /\s*s\.?r\.?l\.?\s*$/i,
    /\s*srl\s*$/i,
    /\s*s\.?p\.?a\.?\s*$/i,
    /\s*spa\s*$/i,
    /\s*s\.?l\.?\s*$/i,
    /\s*b\.?v\.?\s*$/i,
    /\s*n\.?v\.?\s*$/i,
];
function normalizeCompanyName(name) {
    if (!name)
        return "";
    let normalized = name.toLowerCase().trim();
    for (const suffix of COMPANY_SUFFIXES) {
        normalized = normalized.replace(suffix, "");
    }
    normalized = normalized.replace(/[^a-z0-9äöüß\s]/g, " ");
    normalized = normalized
        .replace(/ä/g, "ae")
        .replace(/ö/g, "oe")
        .replace(/ü/g, "ue")
        .replace(/ß/g, "ss");
    normalized = normalized.replace(/\s+/g, " ").trim();
    return normalized;
}
// ============ Similarity Calculation ============
function levenshteinDistance(a, b) {
    const matrix = [];
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
            }
            else {
                matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
            }
        }
    }
    return matrix[b.length][a.length];
}
function calculateCompanyNameSimilarity(name1, name2) {
    const normalized1 = normalizeCompanyName(name1);
    const normalized2 = normalizeCompanyName(name2);
    // Guard against empty/invalid tokens (e.g. legal suffix-only aliases like "LLC")
    // to avoid broad false matches via string containment.
    if (!normalized1 || !normalized2)
        return 0;
    if (normalized1 === normalized2)
        return 100;
    // Phonetic match (Cologne Phonetics) - "Müller" matches "Mueller" matches "MULLER"
    const phonetic1 = colognePhonetic(normalized1);
    const phonetic2 = colognePhonetic(normalized2);
    if (phonetic1 && phonetic2 && phonetic1.length >= 2 && phonetic1 === phonetic2) {
        return 92; // Strong phonetic match
    }
    if (normalized1.includes(normalized2) || normalized2.includes(normalized1)) {
        const shorter = normalized1.length < normalized2.length ? normalized1 : normalized2;
        const longer = normalized1.length >= normalized2.length ? normalized1 : normalized2;
        const coverage = shorter.length / longer.length;
        return Math.round(75 + coverage * 25);
    }
    const maxLen = Math.max(normalized1.length, normalized2.length);
    if (maxLen === 0)
        return 0;
    const distance = levenshteinDistance(normalized1, normalized2);
    return Math.round(((maxLen - distance) / maxLen) * 100);
}
function matchTransaction(transaction, userPartners, globalPartners) {
    const results = [];
    // Process user partners first
    for (const partner of userPartners) {
        const match = matchSinglePartner(transaction, partner, "user");
        if (match) {
            results.push(match);
        }
    }
    // Then global partners
    for (const partner of globalPartners) {
        const match = matchSinglePartner(transaction, partner, "global");
        if (match) {
            const existingMatch = results.find((r) => r.partnerId === match.partnerId && r.partnerType === match.partnerType);
            if (!existingMatch) {
                results.push(match);
            }
        }
    }
    // Sort with user partners taking absolute precedence over global when both above threshold
    const AUTO_ASSIGN_THRESHOLD = 89;
    results.sort((a, b) => {
        const aAboveThreshold = a.confidence >= AUTO_ASSIGN_THRESHOLD;
        const bAboveThreshold = b.confidence >= AUTO_ASSIGN_THRESHOLD;
        // If both above threshold, user always wins over global
        if (aAboveThreshold && bAboveThreshold) {
            if (a.partnerType === "user" && b.partnerType === "global")
                return -1;
            if (a.partnerType === "global" && b.partnerType === "user")
                return 1;
            // Same type: sort by confidence
            return b.confidence - a.confidence;
        }
        // If only one is above threshold, it wins
        if (aAboveThreshold && !bAboveThreshold)
            return -1;
        if (!aAboveThreshold && bAboveThreshold)
            return 1;
        // Both below threshold: sort by confidence, user wins on ties
        if (b.confidence !== a.confidence) {
            return b.confidence - a.confidence;
        }
        if (a.partnerType === "user" && b.partnerType === "global")
            return -1;
        if (a.partnerType === "global" && b.partnerType === "user")
            return 1;
        return 0;
    });
    return results.slice(0, 3);
}
function matchSinglePartner(transaction, partner, partnerType) {
    const candidates = [];
    // 1. IBAN match (100%)
    if (transaction.partnerIban && partner.ibans && partner.ibans.length > 0) {
        const txIban = normalizeIban(transaction.partnerIban);
        for (const iban of partner.ibans) {
            if (normalizeIban(iban) === txIban) {
                // IBAN match is definitive - return immediately
                return {
                    partnerId: partner.id,
                    partnerType,
                    partnerName: partner.name,
                    confidence: 100,
                    source: "iban",
                };
            }
        }
    }
    // 2. Pattern match - works for both learnedPatterns (user) and patterns (global)
    // Use flexible matching that tries multiple field combinations
    const allPatterns = [
        ...(partner.learnedPatterns || []),
        ...(partner.patterns || []),
    ];
    const txName = transaction.name || null;
    const txPartner = transaction.partner || null;
    const txReference = transaction.reference || null;
    // Combined text for exclusion checking
    const combinedForExclusion = [txName, txPartner, txReference]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    for (const p of allPatterns) {
        // Use flexible matching that tries multiple field combinations
        if ((0, pattern_utils_1.matchPatternFlexible)(p.pattern, txName, txPartner, txReference)) {
            // Check exclusions - if any exclusion pattern matches, skip this pattern
            // Check both p.exclude (static patterns) and p.excludePatterns (learned patterns)
            const excludeList = [...(p.exclude || []), ...(p.excludePatterns || [])];
            const excluded = excludeList.some(excl => combinedForExclusion && (0, pattern_utils_1.globMatch)(excl, combinedForExclusion));
            if (excluded)
                continue;
            candidates.push({
                partnerId: partner.id,
                partnerType,
                partnerName: partner.name,
                confidence: p.confidence, // Use pattern confidence directly, no penalty
                source: "pattern",
            });
        }
    }
    // 3. Website match (90%)
    if (partner.website) {
        const normalizedWebsite = normalizeUrl(partner.website);
        const txText = `${transaction.name || ""} ${transaction.partner || ""}`.toLowerCase();
        if (txText.includes(normalizedWebsite)) {
            candidates.push({
                partnerId: partner.id,
                partnerType,
                partnerName: partner.name,
                confidence: 90,
                source: "website",
            });
        }
    }
    // 4. Name matching (60-90%, boosted if multiple match)
    // Combine transaction text for matching
    const txCombinedText = [transaction.name, transaction.partner, transaction.reference]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    const namesToCheck = [partner.name, ...(partner.aliases || [])];
    const matchedNames = [];
    for (let i = 0; i < namesToCheck.length; i++) {
        const name = namesToCheck[i];
        const isAlias = i > 0;
        const normalizedName = normalizeCompanyName(name);
        if (!normalizedName || normalizedName.length < 3) {
            continue;
        }
        // Check if this name/alias appears in transaction text
        if (txCombinedText.includes(normalizedName) && normalizedName.length >= 3) {
            matchedNames.push({ name, similarity: 95, isAlias });
        }
        else if (transaction.partner) {
            const similarity = calculateCompanyNameSimilarity(transaction.partner, name);
            if (similarity >= 60) {
                matchedNames.push({ name, similarity, isAlias });
            }
        }
        else if (transaction.name) {
            const similarity = calculateCompanyNameSimilarity(transaction.name, name);
            if (similarity >= 70) {
                matchedNames.push({ name, similarity, isAlias });
            }
        }
    }
    if (matchedNames.length > 0) {
        // Check if BOTH primary name AND an alias matched - strong signal
        const hasNameMatch = matchedNames.some(m => !m.isAlias);
        const hasAliasMatch = matchedNames.some(m => m.isAlias);
        const bestSimilarity = Math.max(...matchedNames.map(m => m.similarity));
        let confidence;
        if (hasNameMatch && hasAliasMatch) {
            // Both name and alias found - boost to 92-95%
            confidence = Math.min(95, 92 + (bestSimilarity - 60) * 0.075);
        }
        else {
            // Single match - normal scoring (60-90%)
            confidence = Math.min(90, 60 + ((bestSimilarity - 60) * 30) / 40);
        }
        candidates.push({
            partnerId: partner.id,
            partnerType,
            partnerName: partner.name,
            confidence: Math.round(confidence),
            source: "name",
        });
    }
    // Return the best candidate
    if (candidates.length === 0) {
        return null;
    }
    return candidates.reduce((best, current) => current.confidence > best.confidence ? current : best);
}
function shouldAutoApply(confidence) {
    return confidence >= 89;
}
//# sourceMappingURL=partner-matcher.js.map