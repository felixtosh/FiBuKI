/**
 * @deprecated DO NOT USE - This frontend scoring is deprecated.
 *
 * All scoring must happen server-side for consistency:
 * - Local files: Read pre-computed `file.transactionSuggestions` (from matchFileTransactions)
 * - Gmail attachments: Call `scoreAttachmentMatchCallable` Firebase function
 * - API: Use `/api/matching/score-files` which proxies to server-side scoring
 *
 * See CLAUDE.md "Server-Side Scoring Only" section for details.
 *
 * ---
 * LEGACY DOCUMENTATION (kept for reference):
 *
 * Unified File/Attachment Match Scoring
 *
 * Scoring factors:
 * - isLikelyReceipt (PDF/image): +15%
 * - Filename has invoice keyword: +25%
 * - Subject has invoice keyword: +15%
 * - Email text has invoice keyword: +10%
 * - Amount appears in email/filename: +20%
 * - Partner name in email/filename: +10%
 * - Invoice pattern match in filename: +35% (or token fallback: +10%)
 * - Sender domain matches known domains: +20%
 * - Learned Gmail pattern: +10%
 * - Date multiplier: 0.25x - 1.0x based on distance
 *
 * For local files with extracted data:
 * - Exact amount match: +40%
 * - Amount ±1%: +38%
 * - Amount ±5%: +30%
 * - Amount ±10%: +20%
 * - Partner text match: +20%
 * - Date proximity: +4-15%
 */

// Receipt/invoice keywords (multilingual)
export const RECEIPT_KEYWORDS = [
  "invoice",
  "rechnung",
  "receipt",
  "beleg",
  "quittung",
  "faktura",
  "bon",
  "bill",
];

// ============================================================================
// Input/Output Types
// ============================================================================

export interface ScoreFileInput {
  // File info
  fileName: string;
  fileType: string; // MIME type

  // File extracted data (for local files)
  extractedAmount?: number | null; // in cents
  extractedDate?: Date | null;
  extractedPartner?: string | null;

  // Email metadata (for Gmail attachments)
  emailSubject?: string | null;
  emailFrom?: string | null;
  emailSnippet?: string | null;
  emailBodyText?: string | null;
  emailDate?: Date | null;
  integrationId?: string | null;

  // Transaction info
  transactionAmount?: number | null; // in cents
  transactionDate?: Date | null;
  transactionName?: string | null;
  transactionReference?: string | null;
  transactionPartner?: string | null;
  transactionPartnerId?: string | null;

  // File's assigned partner (for partner ID matching)
  filePartnerId?: string | null;

  // Partner info (for domain/pattern matching)
  partnerName?: string | null;
  partnerEmailDomains?: string[] | null;
  partnerFileSourcePatterns?: Array<{
    sourceType: string;
    integrationId?: string;
  }> | null;
}

export interface ScoreFileResult {
  score: number; // 0-100 (percentage)
  label: "Strong" | "Likely" | null;
  reasons: string[];
}

// ============================================================================
// Helper Functions
// ============================================================================

function buildAmountVariants(amountCents?: number | null): string[] {
  if (amountCents == null) return [];
  const amount = Math.abs(amountCents) / 100;
  const fixed = amount.toFixed(2);
  const withComma = fixed.replace(".", ",");

  const variants = [
    fixed, // 4480.00
    withComma, // 4480,00
    amount.toLocaleString("en-US", { minimumFractionDigits: 2 }), // 4,480.00
    amount.toLocaleString("de-DE", { minimumFractionDigits: 2 }), // 4.480,00
    Math.round(amount).toString(), // 4480
  ];

  return [...new Set(variants)].map((v) => v.toLowerCase());
}

function extractTokens(text?: string | null): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

function containsAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function extractInvoicePatterns(text: string): string[] {
  if (!text) return [];
  const patterns: string[] = [];
  // Match invoice-style references like R-2025.006, INV2024-001, RE20240315
  const invoicePattern = /[A-Za-z]{1,4}[-.]?\d{4,}[-.]?\d*/g;
  patterns.push(...(text.match(invoicePattern) || []));
  // Match long numeric sequences (6+ digits) like 202401150034
  const numericPattern = /\d{6,}/g;
  patterns.push(...(text.match(numericPattern) || []));
  return Array.from(new Set(patterns.map(p => p.toLowerCase().replace(/[-.\s]/g, ""))));
}

function extractEmailDomain(email?: string | null): string | null {
  if (!email) return null;
  const match = email.toLowerCase().match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  return match ? match[1] : null;
}

function isLikelyReceiptMimeType(mimeType: string): boolean {
  const receiptTypes = [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
  ];
  return receiptTypes.includes(mimeType.toLowerCase());
}

/**
 * Fuzzy text matching for partner names
 */
export function fuzzyTextMatch(
  a: string | undefined | null,
  b: string | undefined | null
): boolean {
  if (!a || !b) return false;
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normA = normalize(a);
  const normB = normalize(b);
  return normA.includes(normB) || normB.includes(normA);
}

// ============================================================================
// Main Scoring Function
// ============================================================================

/**
 * Score how well a file matches a transaction
 * Returns a score from 0-100 with reasons
 */
export function scoreFileMatch(input: ScoreFileInput): ScoreFileResult {
  const {
    fileName,
    fileType,
    extractedAmount,
    extractedDate,
    extractedPartner,
    emailSubject,
    emailFrom,
    emailSnippet,
    emailBodyText,
    emailDate,
    integrationId,
    transactionAmount,
    transactionDate,
    transactionName,
    transactionReference,
    transactionPartner,
    transactionPartnerId,
    filePartnerId,
    partnerName,
    partnerEmailDomains,
    partnerFileSourcePatterns,
  } = input;

  // Build search targets
  const amountVariants = buildAmountVariants(transactionAmount);
  const partnerTokens = [
    ...extractTokens(partnerName),
    ...extractTokens(transactionPartner),
  ];
  const invoiceTokens = [
    ...extractTokens(transactionName),
    ...extractTokens(transactionReference),
  ];
  const knownDomains = (partnerEmailDomains || []).map((d) => d.toLowerCase());
  const gmailPatterns = (partnerFileSourcePatterns || []).filter(
    (pattern) => pattern.sourceType === "gmail" && pattern.integrationId
  );

  // Build combined text from email
  const combined = [emailSubject, emailSnippet, emailFrom, emailBodyText]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const filenameLower = fileName.toLowerCase();
  const subjectLower = (emailSubject || "").toLowerCase();
  const senderDomain = extractEmailDomain(emailFrom);

  let score = 0;
  const reasons: string[] = [];
  let dateMultiplier = 1;

  // === PARTNER ID MATCH (strongest signal for local files) ===
  if (transactionPartnerId && filePartnerId && transactionPartnerId === filePartnerId) {
    score += 0.35;
    reasons.push("Same partner ID");
  }

  // === NUMERIC AMOUNT COMPARISON (for local files with extracted data) ===
  let amountMismatch = false;
  if (extractedAmount != null && transactionAmount != null) {
    const fileAmt = Math.abs(extractedAmount);
    const txAmt = Math.abs(transactionAmount);
    const diff = txAmt > 0 ? Math.abs(fileAmt - txAmt) / txAmt : 1;

    if (diff === 0) {
      score += 0.4; // Exact match: +40%
      reasons.push("Exact amount match");
    } else if (diff <= 0.01) {
      score += 0.38; // ±1%
      reasons.push("Amount ±1%");
    } else if (diff <= 0.05) {
      score += 0.3; // ±5%
      reasons.push("Amount ±5%");
    } else if (diff <= 0.1) {
      score += 0.2; // ±10%
      reasons.push("Amount ±10%");
    } else if (diff > 0.5) {
      amountMismatch = true;
      reasons.push(`Amount mismatch: ${(diff * 100).toFixed(0)}% diff`);
    }
  }

  // === FILE EXTRACTED PARTNER MATCH ===
  if (extractedPartner && (partnerName || transactionPartner)) {
    const filePartnerLower = extractedPartner.toLowerCase();
    const targetPartners = [partnerName, transactionPartner]
      .filter(Boolean)
      .map((p) => p!.toLowerCase());

    const hasMatch = targetPartners.some(
      (p) => filePartnerLower.includes(p) || p.includes(filePartnerLower)
    );
    if (hasMatch) {
      score += 0.2; // Partner match: +20%
      reasons.push("File partner matches transaction");
    }
  }

  // === FUZZY PARTNER NAME MATCH (fallback when no extracted partner) ===
  if (!extractedPartner && !filePartnerId) {
    const txPartnerText = transactionPartner || transactionName;
    if (fuzzyTextMatch(txPartnerText, fileName)) {
      score += 0.15;
      reasons.push("Partner in filename");
    }
  }

  // === FILE EXTRACTED DATE PROXIMITY ===
  if (extractedDate && transactionDate) {
    const dayDiff =
      Math.abs(extractedDate.getTime() - transactionDate.getTime()) /
      (1000 * 60 * 60 * 24);
    if (dayDiff === 0) {
      score += 0.15; // Same day: +15%
      reasons.push("Same day");
    } else if (dayDiff <= 3) {
      score += 0.12;
      reasons.push("Within 3 days");
    } else if (dayDiff <= 7) {
      score += 0.08;
      reasons.push("Within 7 days");
    } else if (dayDiff <= 14) {
      score += 0.04;
      reasons.push("Within 14 days");
    }
  }

  // === EMAIL/ATTACHMENT SPECIFIC SCORING ===

  // 1. Likely receipt file type (+15%)
  if (isLikelyReceiptMimeType(fileType)) {
    score += 0.15;
    reasons.push("Likely receipt file type");
  }

  // 2. Filename has invoice keyword (+25%)
  if (containsAny(filenameLower, RECEIPT_KEYWORDS)) {
    score += 0.25;
    reasons.push("Filename has invoice keyword");
  }

  // 3. Subject has invoice keyword (+15%)
  if (containsAny(subjectLower, RECEIPT_KEYWORDS)) {
    score += 0.15;
    reasons.push("Subject has invoice keyword");
  }

  // 4. Email text has invoice keyword (+10%)
  if (combined && containsAny(combined, RECEIPT_KEYWORDS)) {
    score += 0.1;
    reasons.push("Email text has invoice keyword");
  }

  // 5. Amount appears in email or filename (+20%)
  if (
    amountVariants.length > 0 &&
    containsAny(combined + " " + filenameLower, amountVariants)
  ) {
    score += 0.2;
    reasons.push("Amount appears in email or filename");
  }

  // 6. Partner name appears in email or filename (+10%)
  if (partnerTokens.length > 0 && containsAny(combined + " " + filenameLower, partnerTokens)) {
    score += 0.1;
    reasons.push("Partner name appears in email or filename");
  }

  // 7. Invoice reference matching (cascading: exact pattern > tokens)
  const txPatterns = extractInvoicePatterns(
    [transactionName, transactionReference].filter(Boolean).join(" ")
  );
  const filePatterns = extractInvoicePatterns(fileName);
  const hasInvoicePatternMatch = txPatterns.length > 0 && filePatterns.length > 0 &&
    txPatterns.some(tp => tp.length >= 4 &&
      filePatterns.some(fp => fp.includes(tp) || tp.includes(fp)));

  if (hasInvoicePatternMatch) {
    score += 0.35;
    reasons.push("Invoice number pattern matches filename");
  } else if (
    invoiceTokens.length > 0 &&
    containsAny(combined + " " + filenameLower, invoiceTokens)
  ) {
    score += 0.1;
    reasons.push("Invoice reference tokens in email or filename");
  }

  // 8. Sender domain matches known partner domains (+20%)
  if (senderDomain && knownDomains.includes(senderDomain)) {
    score += 0.2;
    reasons.push(`Sender domain matches ${senderDomain}`);
  }

  // 9. Learned Gmail account pattern (+10%)
  if (
    integrationId &&
    gmailPatterns.some((pattern) => pattern.integrationId === integrationId)
  ) {
    score += 0.1;
    reasons.push("Learned Gmail account pattern");
  }

  // === DATE PROXIMITY MULTIPLIER (for email date) ===
  if (transactionDate && emailDate) {
    const dayDiff =
      Math.abs(emailDate.getTime() - transactionDate.getTime()) /
      (1000 * 60 * 60 * 24);
    const isBeforeTransaction = emailDate.getTime() < transactionDate.getTime();

    if (isBeforeTransaction) {
      // File is from BEFORE the transaction (normal case - invoice before payment)
      if (dayDiff <= 14) dateMultiplier = 1;
      else if (dayDiff <= 30) dateMultiplier = 0.95;
      else if (dayDiff <= 60) dateMultiplier = 0.9;
      else if (dayDiff <= 90) dateMultiplier = 0.85;
      else if (dayDiff <= 180) dateMultiplier = 0.75;
      else dateMultiplier = 0.6;
    } else {
      // File is from AFTER the transaction (unusual - maybe a receipt)
      if (dayDiff <= 7) dateMultiplier = 1;
      else if (dayDiff <= 14) dateMultiplier = 0.9;
      else if (dayDiff <= 30) dateMultiplier = 0.75;
      else if (dayDiff <= 60) dateMultiplier = 0.55;
      else if (dayDiff <= 90) dateMultiplier = 0.4;
      else dateMultiplier = 0.3;
    }
    reasons.push(
      `Date distance: ${Math.round(dayDiff)} days ${isBeforeTransaction ? "before" : "after"} (×${dateMultiplier.toFixed(2)})`
    );
  }

  // Apply date multiplier
  score = score * dateMultiplier;

  // Apply amount mismatch penalty (reduce score by 60% when amounts are way off)
  if (amountMismatch) {
    score = score * 0.4;
  }

  // Cap at 95%
  if (score > 0.95) score = 0.95;

  // Convert to percentage (0-100)
  const scorePercent = Math.round(score * 100);

  // Determine label
  const label =
    scorePercent >= 75 ? "Strong" : scorePercent >= 40 ? "Likely" : null;

  return {
    score: scorePercent,
    label,
    reasons,
  };
}

// ============================================================================
// Thresholds
// ============================================================================

/** Minimum score threshold for suggestions/downloads */
export const FILE_MATCH_THRESHOLD = 60;

/** Minimum score threshold for auto-connecting */
export const FILE_AUTO_CONNECT_THRESHOLD = 75;

/** Score threshold for "great match" - stop searching */
export const GREAT_MATCH_THRESHOLD = 75;

/** Number of great matches needed to stop searching */
export const GREAT_MATCH_COUNT = 2;
