/**
 * Fuzzy string matching utilities for partner name matching
 */

/**
 * Cologne Phonetics (Kölner Phonetik) implementation
 * A phonetic algorithm optimized for German but works reasonably for other languages.
 * Similar words sound alike and produce the same phonetic code.
 *
 * Rules: https://en.wikipedia.org/wiki/Cologne_phonetics
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
        code = ""; // H is ignored
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
        code = "0"; // Treat J like a vowel
        break;
      case "y":
        code = "0"; // Treat Y like a vowel
        break;
      default:
        code = "";
    }

    codes.push(code);
  }

  // Remove consecutive duplicates and leading zeros (except single "0")
  let result = "";
  let lastCode = "";

  for (const code of codes) {
    for (const c of code) { // Handle "48" from X
      if (c !== lastCode) {
        result += c;
        lastCode = c;
      }
    }
  }

  // Remove all zeros except if string would be empty
  const withoutZeros = result.replace(/0/g, "");
  return withoutZeros || "0";
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  // Initialize first column
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  // Initialize first row
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  // Fill in the rest of the matrix
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j] + 1 // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Calculate similarity score between two strings (0-100)
 */
export function calculateSimilarity(str1: string, str2: string): number {
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();

  if (s1 === s2) return 100;
  if (s1.length === 0 || s2.length === 0) return 0;

  const maxLen = Math.max(s1.length, s2.length);
  const distance = levenshteinDistance(s1, s2);
  const similarity = ((maxLen - distance) / maxLen) * 100;

  return Math.round(similarity);
}

/**
 * Common company suffixes to remove for matching
 */
const COMPANY_SUFFIXES = [
  // German/Austrian
  /\s*gmbh\s*$/i,
  /\s*g\.m\.b\.h\.\s*$/i,
  /\s*ges\.?m\.?b\.?h\.?\s*$/i,
  /\s*ag\s*$/i,
  /\s*kg\s*$/i,
  /\s*ohg\s*$/i,
  /\s*og\s*$/i,
  /\s*e\.?u\.?\s*$/i,
  /\s*einzelunternehmen\s*$/i,
  /\s*genossenschaft\s*$/i,
  /\s*gen\.?\s*$/i,
  /\s*&\s*co\.?\s*(kg|ohg)?\s*$/i,
  /\s*mbh\s*$/i,

  // English
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
  /\s*company\s*$/i,

  // French
  /\s*s\.?a\.?\s*$/i,
  /\s*s\.?a\.?r\.?l\.?\s*$/i,
  /\s*sarl\s*$/i,
  /\s*sas\s*$/i,
  /\s*s\.?a\.?s\.?\s*$/i,

  // Italian
  /\s*s\.?r\.?l\.?\s*$/i,
  /\s*srl\s*$/i,
  /\s*s\.?p\.?a\.?\s*$/i,
  /\s*spa\s*$/i,

  // Spanish
  /\s*s\.?l\.?\s*$/i,
  /\s*sl\s*$/i,

  // Dutch
  /\s*b\.?v\.?\s*$/i,
  /\s*bv\s*$/i,
  /\s*n\.?v\.?\s*$/i,
  /\s*nv\s*$/i,
];

/**
 * Normalize company name for matching
 * - Remove common suffixes (GmbH, AG, Ltd, Inc, etc.)
 * - Remove punctuation
 * - Convert to lowercase
 * - Collapse multiple spaces
 */
export function normalizeCompanyName(name: string): string {
  if (!name) return "";

  let normalized = name.toLowerCase().trim();

  // Remove company suffixes
  for (const suffix of COMPANY_SUFFIXES) {
    normalized = normalized.replace(suffix, "");
  }

  // Remove punctuation except alphanumeric and spaces
  normalized = normalized.replace(/[^a-z0-9äöüß\s]/g, " ");

  // Handle German umlauts for matching
  normalized = normalized
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss");

  // Collapse multiple spaces
  normalized = normalized.replace(/\s+/g, " ").trim();

  return normalized;
}

/** Cologne codes shorter than this are collisions, not phonetic matches. */
export const MIN_PHONETIC_CODE_LENGTH = 3;
/** Equal Cologne codes must also share this much spelling (Levenshtein ratio). */
export const MIN_PHONETIC_SPELLING_SIMILARITY = 50;

/**
 * Calculate company name similarity (using normalized names)
 * Uses phonetic matching (Cologne Phonetics) for better German name matching.
 */
export function calculateCompanyNameSimilarity(name1: string, name2: string): number {
  const normalized1 = normalizeCompanyName(name1);
  const normalized2 = normalizeCompanyName(name2);

  // Check for exact match after normalization
  if (normalized1 === normalized2) return 100;

  // Phonetic match (Cologne Phonetics) - "Müller" matches "Mueller" matches "MULLER"
  // Applied to all names, not just German (works reasonably for other languages too)
  // Guarded against hash collisions: Cologne drops vowels and has 8 digits, so
  // "uber"/"bayer"/"porr" all code to "17" and "esim me"/"s immo" to "86".
  // Mirrors functions/src/utils/partner-matcher.ts (fork #71).
  const phonetic1 = colognePhonetic(normalized1);
  const phonetic2 = colognePhonetic(normalized2);
  if (
    phonetic1 &&
    phonetic2 &&
    phonetic1 === phonetic2 &&
    phonetic1.length >= MIN_PHONETIC_CODE_LENGTH &&
    calculateSimilarity(normalized1, normalized2) >= MIN_PHONETIC_SPELLING_SIMILARITY
  ) {
    return 92; // Strong phonetic match
  }

  // Check if one contains the other (common for abbreviations)
  if (normalized1.includes(normalized2) || normalized2.includes(normalized1)) {
    const shorter = normalized1.length < normalized2.length ? normalized1 : normalized2;
    const longer = normalized1.length >= normalized2.length ? normalized1 : normalized2;
    // Scale by how much of the longer string is covered
    const coverage = shorter.length / longer.length;
    return Math.round(75 + coverage * 25); // 75-100 range
  }

  // Fall back to Levenshtein similarity
  return calculateSimilarity(normalized1, normalized2);
}

/**
 * Find best match from a list of candidates
 */
export function findBestNameMatch(
  searchName: string,
  candidates: Array<{ name: string; aliases?: string[] }>
): { index: number; score: number; matchedName: string } | null {
  const normalizedSearch = normalizeCompanyName(searchName);
  let bestMatch: { index: number; score: number; matchedName: string } | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const namesToCheck = [candidate.name, ...(candidate.aliases || [])];

    for (const name of namesToCheck) {
      const score = calculateCompanyNameSimilarity(searchName, name);

      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { index: i, score, matchedName: name };
      }
    }
  }

  // Only return if score is at least 60%
  return bestMatch && bestMatch.score >= 60 ? bestMatch : null;
}

/**
 * Check if two VAT IDs match (normalized)
 */
export function vatIdsMatch(vat1: string, vat2: string): boolean {
  if (!vat1 || !vat2) return false;

  // Normalize: uppercase, remove spaces and special chars
  const normalize = (vat: string) =>
    vat.toUpperCase().replace(/[^A-Z0-9]/g, "");

  return normalize(vat1) === normalize(vat2);
}
