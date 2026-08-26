/**
 * Server-side partner matching utilities
 * Mirrors the client-side matching logic for Cloud Functions
 */

// Import from pattern-utils for local use
import { globMatch, matchPatternFlexible } from "./pattern-utils";
import type { LearnedPattern, MatchPattern } from "./pattern-utils";

// Re-export for backwards compatibility
export { globMatch, matchPatternFlexible, LearnedPattern, MatchPattern } from "./pattern-utils";

// ============ Cologne Phonetics ============

/**
 * Cologne Phonetics (Kölner Phonetik) implementation
 * A phonetic algorithm optimized for German but works reasonably for other languages.
 * Similar words sound alike and produce the same phonetic code.
 */
export function colognePhonetic(str: string): string {
  if (!str) return "";

  // Normalize: lowercase, remove non-letters, handle umlauts
  let s = str.toLowerCase()
    .replace(/ä/g, "a")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/ß/g, "ss")
    .replace(/[^a-z]/g, "");

  if (s.length === 0) return "";

  const codes: string[] = [];

  for (let i = 0; i < s.length; i++) {
    const char = s[i];
    const prev = i > 0 ? s[i - 1] : "";
    const next = i < s.length - 1 ? s[i + 1] : "";

    let code: string;

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
        } else {
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

export function normalizeUrl(url: string): string {
  if (!url) return "";

  try {
    let normalized = url.toLowerCase().trim();
    normalized = normalized.replace(/^https?:\/\//, "");
    normalized = normalized.replace(/^www\./, "");
    normalized = normalized.replace(/\/$/, "");
    normalized = normalized.split("?")[0].split("#")[0];
    return normalized;
  } catch {
    return url.toLowerCase().trim();
  }
}

// ============ IBAN Normalization ============

export function normalizeIban(iban: string): string {
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

export function normalizeCompanyName(name: string): string {
  if (!name) return "";

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

/** Similarity awarded to a plausible Cologne-phonetic match ("Schmidt" / "Schmitt"). */
export const PHONETIC_MATCH_SIMILARITY = 92;

/**
 * Cologne codes shorter than this are hash collisions, not phonetic matches:
 * the alphabet is 8 digits and vowels are dropped, so "uber", "bayer" and
 * "porr" all reduce to "17" and "esim me" / "s immo" both reduce to "86".
 */
export const MIN_PHONETIC_CODE_LENGTH = 3;

/**
 * Two strings with equal Cologne codes must also share at least this much
 * spelling (Levenshtein ratio) before the equality counts as a phonetic match.
 * "Meyer Bau" / "Maier Bau" sit at 78, "Schmidt" / "Schmitt" at 86;
 * "uber" / "bayer" at 40 and "esim me" / "s immo" at 43 are rejected.
 * The ratio also bounds the length difference: two strings whose lengths
 * differ by more than 2:1 can never reach 50.
 */
export const MIN_PHONETIC_SPELLING_SIMILARITY = 50;

function isPlausiblePhoneticMatch(code: string, normalized1: string, normalized2: string): boolean {
  if (code.length < MIN_PHONETIC_CODE_LENGTH) return false;
  return levenshteinSimilarity(normalized1, normalized2) >= MIN_PHONETIC_SPELLING_SIMILARITY;
}

function levenshteinSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  const distance = levenshteinDistance(a, b);
  return Math.round(((maxLen - distance) / maxLen) * 100);
}

export function calculateCompanyNameSimilarity(name1: string, name2: string): number {
  const normalized1 = normalizeCompanyName(name1);
  const normalized2 = normalizeCompanyName(name2);

  // Guard against empty/invalid tokens (e.g. legal suffix-only aliases like "LLC")
  // to avoid broad false matches via string containment.
  if (!normalized1 || !normalized2) return 0;

  if (normalized1 === normalized2) return 100;

  // Phonetic match (Cologne Phonetics) - "Müller" matches "Mueller" matches "MULLER"
  const phonetic1 = colognePhonetic(normalized1);
  const phonetic2 = colognePhonetic(normalized2);
  if (
    phonetic1 &&
    phonetic2 &&
    phonetic1 === phonetic2 &&
    isPlausiblePhoneticMatch(phonetic1, normalized1, normalized2)
  ) {
    return PHONETIC_MATCH_SIMILARITY;
  }

  if (normalized1.includes(normalized2) || normalized2.includes(normalized1)) {
    const shorter = normalized1.length < normalized2.length ? normalized1 : normalized2;
    const longer = normalized1.length >= normalized2.length ? normalized1 : normalized2;
    const coverage = shorter.length / longer.length;
    return Math.round(75 + coverage * 25);
  }

  return levenshteinSimilarity(normalized1, normalized2);
}

// ============ Partner Matching ============

export interface PartnerData {
  id: string;
  name: string;
  aliases: string[];
  ibans: string[];
  website?: string;
  vatId?: string;
  globalPartnerId?: string | null;
  /** AI-learned patterns (user partners) */
  learnedPatterns?: LearnedPattern[];
  /** Static patterns (global partners from presets) */
  patterns?: MatchPattern[];
}

export interface TransactionData {
  id: string;
  partner: string | null;
  partnerIban: string | null;
  name: string;
  reference: string | null;
}

export interface MatchResult {
  partnerId: string;
  partnerType: "global" | "user";
  partnerName: string;
  confidence: number;
  source: "iban" | "vatId" | "website" | "name" | "pattern";
}

export function matchTransaction(
  transaction: TransactionData,
  userPartners: PartnerData[],
  globalPartners: PartnerData[]
): MatchResult[] {
  const results: MatchResult[] = [];

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
      const existingMatch = results.find(
        (r) => r.partnerId === match.partnerId && r.partnerType === match.partnerType
      );
      if (!existingMatch) {
        results.push(match);
      }
    }
  }

  // Sort with user partners taking absolute precedence over global when both above threshold
  results.sort((a, b) => {
    const aAboveThreshold = shouldAutoApply(a.confidence);
    const bAboveThreshold = shouldAutoApply(b.confidence);

    // If both above threshold, user always wins over global
    if (aAboveThreshold && bAboveThreshold) {
      if (a.partnerType === "user" && b.partnerType === "global") return -1;
      if (a.partnerType === "global" && b.partnerType === "user") return 1;
      // Same type: sort by confidence
      return b.confidence - a.confidence;
    }

    // If only one is above threshold, it wins
    if (aAboveThreshold && !bAboveThreshold) return -1;
    if (!aAboveThreshold && bAboveThreshold) return 1;

    // Both below threshold: sort by confidence, user wins on ties
    if (b.confidence !== a.confidence) {
      return b.confidence - a.confidence;
    }
    if (a.partnerType === "user" && b.partnerType === "global") return -1;
    if (a.partnerType === "global" && b.partnerType === "user") return 1;
    return 0;
  });

  return results.slice(0, 3);
}

function matchSinglePartner(
  transaction: TransactionData,
  partner: PartnerData,
  partnerType: "global" | "user"
): MatchResult | null {
  const candidates: MatchResult[] = [];

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
  const allPatterns: MatchPattern[] = [
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
    if (matchPatternFlexible(p.pattern, txName, txPartner, txReference)) {
      // Check exclusions - if any exclusion pattern matches, skip this pattern
      // Check both p.exclude (static patterns) and p.excludePatterns (learned patterns)
      const excludeList = [...(p.exclude || []), ...((p as { excludePatterns?: string[] }).excludePatterns || [])];
      const excluded = excludeList.some(excl => combinedForExclusion && globMatch(excl, combinedForExclusion));
      if (excluded) continue;

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

  // 4. Name matching (60-90%, +ALIAS_AGREEMENT_BONUS when name and alias agree)
  // Combine transaction text for matching
  const txCombinedText = [transaction.name, transaction.partner, transaction.reference]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const namesToCheck = [partner.name, ...(partner.aliases || [])];
  const matchedNames: { name: string; similarity: number; isAlias: boolean }[] = [];

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
    } else if (transaction.partner) {
      const similarity = calculateCompanyNameSimilarity(transaction.partner, name);
      if (similarity >= 60) {
        matchedNames.push({ name, similarity, isAlias });
      }
    } else if (transaction.name) {
      const similarity = calculateCompanyNameSimilarity(transaction.name, name);
      if (similarity >= 70) {
        matchedNames.push({ name, similarity, isAlias });
      }
    }
  }

  if (matchedNames.length > 0) {
    const hasNameMatch = matchedNames.some(m => !m.isAlias);
    const hasAliasMatch = matchedNames.some(m => m.isAlias);
    const bestSimilarity = Math.max(...matchedNames.map(m => m.similarity));

    candidates.push({
      partnerId: partner.id,
      partnerType,
      partnerName: partner.name,
      confidence: nameMatchConfidence(bestSimilarity, hasNameMatch && hasAliasMatch, partnerType),
      source: "name",
    });
  }

  // Return the best candidate
  if (candidates.length === 0) {
    return null;
  }

  return candidates.reduce((best, current) =>
    current.confidence > best.confidence ? current : best
  );
}

export const AUTO_APPLY_THRESHOLD = 89;

/**
 * Bonus when the partner's primary name AND one of its aliases both match.
 * Bounded so that agreement can never lift approximate evidence over the
 * auto-apply gate on its own: a phonetic-only match (similarity 92 → 84)
 * lands at 88, still below AUTO_APPLY_THRESHOLD.
 */
export const ALIAS_AGREEMENT_BONUS = 4;

/**
 * Similarity from which a name match counts as literal evidence — the name
 * appears verbatim in the transaction text (95) or equals the partner field
 * after normalization (100). Anything lower is approximate (Levenshtein,
 * phonetic, partial containment).
 */
export const LITERAL_NAME_SIMILARITY = 95;

/**
 * Global preset partners are a ~300-entry catalogue of short corporate names
 * the user never chose, so an approximate name match against it is far more
 * likely a collision than a user-list match is. Approximate evidence may
 * suggest a global partner but never auto-apply it.
 */
export const GLOBAL_APPROXIMATE_NAME_CAP = AUTO_APPLY_THRESHOLD - 1;

/**
 * Name-source confidence. Derived from the best similarity (60 → 60, 100 → 90),
 * plus a bounded bonus when name and alias agree. The floor of the old
 * "name + alias" branch (92) sat above the auto-apply gate and turned any
 * pair of weak matches into an unreviewed assignment (fork #71).
 */
export function nameMatchConfidence(
  bestSimilarity: number,
  nameAndAliasAgree: boolean,
  partnerType: "global" | "user"
): number {
  let confidence = Math.min(90, 60 + ((bestSimilarity - 60) * 30) / 40);
  if (nameAndAliasAgree) {
    confidence += ALIAS_AGREEMENT_BONUS;
  }
  if (partnerType === "global" && bestSimilarity < LITERAL_NAME_SIMILARITY) {
    confidence = Math.min(confidence, GLOBAL_APPROXIMATE_NAME_CAP);
  }
  return Math.round(confidence);
}

export function shouldAutoApply(confidence: number): boolean {
  return confidence >= AUTO_APPLY_THRESHOLD;
}
