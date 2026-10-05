/**
 * The chat agent's checks before it connects a File to a Transaction (#665).
 *
 * Moved unchanged from the chat's own connect tool, so the shared
 * `connect_file_to_transaction` handler applies them when the caller is the
 * agent, and only then: an MCP client connects without them, as before. The
 * File Connection writer still owns every rule a connect follows
 * (fileConnections/rules.ts); these come first and only ever refuse.
 *
 * - A pair the File rejected is refused with PAIR_REJECTED unless the agent
 *   says a human asked for it (`overrideDismissal`). Not liftable by
 *   `skipValidation`, which the batch workers pass routinely.
 * - Amount and Partner name are compared first and a mismatch is refused with
 *   VALIDATION_FAILED, unless `skipValidation`. The receipt search worker
 *   cannot skip it and compares more tightly.
 * - The receipt search and Partner file batch workers may replace automated
 *   File Connections.
 *
 * Dependency-free on purpose: the chat's searchLocalFiles reads the same
 * File amount through getFileAmountForValidation.
 */

import { readDismissedTransactionIds } from "../matching/dismissedTransactions";

type Data = Record<string, unknown>;

/** The arguments only the agent's connect reads; the MCP surface has none of them. */
export interface AgentConnectArgs {
  confidence?: unknown;
  skipValidation?: unknown;
  overrideDismissal?: unknown;
  searchQuery?: unknown;
  sourceType?: unknown;
}

/**
 * Helper to check if two names match (fuzzy comparison)
 */
export function doNamesMatch(name1: string | null | undefined, name2: string | null | undefined): boolean {
  if (!name1 || !name2) return false;

  const normalize = (s: string) =>
    s.toLowerCase()
      .replace(/\s*(gmbh|ag|kg|ohg|ug|e\.?k\.?|inc\.?|ltd\.?|llc|co\.?)\s*/gi, " ")
      .replace(/[^a-z0-9\s]/gi, "")
      .replace(/\s+/g, " ")
      .trim();

  const n1 = normalize(name1);
  const n2 = normalize(name2);

  // Exact match after normalization
  if (n1 === n2) return true;

  // One contains the other
  if (n1.includes(n2) || n2.includes(n1)) return true;

  // Check for significant word overlap
  const words1 = n1.split(" ").filter((w) => w.length > 2);
  const words2 = n2.split(" ").filter((w) => w.length > 2);
  const matchingWords = words1.filter((w) =>
    words2.some((w2) => w === w2 || w.includes(w2) || w2.includes(w))
  );

  return matchingWords.length >= 1;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A File's amount in cents for comparing with a Transaction: the best-effort gross nearest to it. */
export function getFileAmountForValidation(
  file: Data | null | undefined,
  txAmount: number | null | undefined
): number | null {
  const extractedAmount = toFiniteNumber(file?.extractedAmount);
  const extractedVatAmount = toFiniteNumber(file?.extractedVatAmount);

  const lineItems = Array.isArray(file?.extractedLineItems) ? file.extractedLineItems : [];
  const lineAmountSum = lineItems.reduce((sum: number, item: unknown) => {
    const amount = toFiniteNumber((item as { amount?: unknown })?.amount);
    return amount === null ? sum : sum + amount;
  }, 0);
  const lineVatSum = lineItems.reduce((sum: number, item: unknown) => {
    const vatAmount = toFiniteNumber((item as { vatAmount?: unknown })?.vatAmount);
    return vatAmount === null ? sum : sum + vatAmount;
  }, 0);

  const candidates: number[] = [];
  if (extractedAmount !== null) {
    candidates.push(extractedAmount);
  }
  if (lineItems.length > 0) {
    candidates.push(lineAmountSum);
    candidates.push(lineAmountSum + lineVatSum);
  } else if (extractedAmount !== null && extractedVatAmount !== null) {
    candidates.push(extractedAmount + extractedVatAmount);
  }

  if (candidates.length === 0) {
    return null;
  }

  const uniqueCandidates = Array.from(new Set(candidates.map((value) => Math.round(value))));
  const txAbs = txAmount != null ? Math.abs(txAmount) : null;

  if (txAbs != null) {
    return uniqueCandidates.reduce((best, candidate) =>
      Math.abs(candidate - txAbs) < Math.abs(best - txAbs) ? candidate : best
    );
  }

  return extractedAmount !== null ? extractedAmount : uniqueCandidates[0];
}

function getDateFromUnknown(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value === "object" && "toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
    const parsed = (value as { toDate: () => unknown }).toDate();
    return parsed instanceof Date && !Number.isNaN(parsed.getTime()) ? parsed : null;
  }
  return null;
}

function getAbsoluteDateDiffDays(date1: Date | null, date2: Date | null): number | null {
  if (!date1 || !date2) return null;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round(Math.abs(date1.getTime() - date2.getTime()) / msPerDay);
}

/**
 * Why the agent may not connect this pair, as the reply the model reads, or
 * null when it may. `file` and `tx` are the caller's own records.
 */
export function agentConnectRefusal(
  fileId: string,
  transactionId: string,
  file: Data,
  tx: Data,
  args: AgentConnectArgs,
  workerType: string | null
): Record<string, unknown> | null {
  const overrideDismissal = args.overrideDismissal === true;
  const skipValidation = args.skipValidation === true;
  const rejectedFileIds = new Set<string>((tx.rejectedFileIds as string[] | undefined) || []);

  // === GATE: this pair was rejected on the file side (fork #101) ===
  //
  // Deliberately ahead of, and outside, the validation block below. That
  // block is skippable with skipValidation, which the batch workers pass
  // routinely, and a gate that the caller most likely to trip it can turn off
  // is not a gate. Overriding a rejection takes saying so: overrideDismissal,
  // which mirrors the UI's own escape hatch (an explicit search, which #94
  // left unfiltered on purpose).
  //
  // The transaction-side twin of this check, rejectedFileIds, stays a warning
  // inside the validation block.
  if (!overrideDismissal && readDismissedTransactionIds(file).has(transactionId)) {
    return {
      error: "PAIR_REJECTED",
      fileId,
      transactionId,
      fileName: file.fileName,
      transactionName: tx.name,
      message:
        `File "${file.fileName}" was rejected for this transaction and is not eligible to be connected. ` +
        `Do not retry this pair — pick a different file, or leave the transaction unmatched. ` +
        `If connecting it is genuinely intended, undo the rejection first (undismiss_transaction_suggestion), ` +
        `or call this tool again with overrideDismissal=true.`,
    };
  }

  const isReceiptSearchWorker = workerType === "receipt_search";
  const effectiveSkipValidation = isReceiptSearchWorker ? false : skipValidation;

  // === VALIDATION: Check for mismatches before connecting ===
  if (effectiveSkipValidation) return null;

  const warnings: string[] = [];

  // 0. Historical rejection safety - don't reconnect files the user rejected for this transaction
  if (rejectedFileIds.has(fileId)) {
    warnings.push(
      `REJECTED BEFORE: File "${file.fileName}" was previously rejected for this transaction.`
    );
  }

  // 1. Amount validation - check if amounts are significantly different
  const txAmount = tx.amount as number | null | undefined; // in cents
  const fileAmount = getFileAmountForValidation(file, txAmount); // in cents (best-effort gross)
  let amountRatio: number | null = null;
  let sameCurrency = true;
  const fileCurrency = String(file.extractedCurrency || tx.currency || "EUR").toUpperCase();
  const txCurrency = String(tx.currency || "EUR").toUpperCase();

  if (fileAmount != null && txAmount != null) {
    const absFileAmount = Math.abs(fileAmount);
    const absTxAmount = Math.abs(txAmount);

    if (absFileAmount > 0 && absTxAmount > 0) {
      amountRatio = absFileAmount / absTxAmount;
      sameCurrency = fileCurrency === txCurrency;

      // Default mode: tolerate broad ratio mismatches for manual/interactive flows.
      // Receipt worker mode: require close amount match to avoid auto-connecting wrong invoices.
      const isAmountMismatch = isReceiptSearchWorker
        ? (sameCurrency ? (amountRatio < 0.9 || amountRatio > 1.1) : (amountRatio < 0.75 || amountRatio > 1.35))
        : (amountRatio < 0.5 || amountRatio > 2.0);

      if (isAmountMismatch) {
        const fileAmtStr = (absFileAmount / 100).toFixed(2);
        const txAmtStr = (absTxAmount / 100).toFixed(2);

        warnings.push(
          `AMOUNT MISMATCH: File has ${fileAmtStr} ${fileCurrency} but transaction is ${txAmtStr} ${txCurrency} ` +
          `(${Math.round(amountRatio * 100)}% ratio). This file likely belongs to a different transaction.`
        );
      }
    }
  }

  // 2. Partner validation - check if file's extracted partner matches transaction
  const filePartner = file.extractedPartner as string | null | undefined;
  const txName = (tx.name || tx.partner) as string | null | undefined;
  const hasTrustedPartnerReference = Boolean(tx.partnerId || tx.partner);
  const txDate = getDateFromUnknown(tx.date);
  const fileDate = getDateFromUnknown(file.extractedDate) || getDateFromUnknown(file.uploadedAt);
  const dateDiffDays = getAbsoluteDateDiffDays(fileDate, txDate);
  const hasStrongAmountMatch = amountRatio != null
    && (sameCurrency
      ? amountRatio >= 0.85 && amountRatio <= 1.15
      : amountRatio >= 0.7 && amountRatio <= 1.4);
  const hasVeryStrongAmountMatch = amountRatio != null
    && (sameCurrency
      ? amountRatio >= 0.95 && amountRatio <= 1.05
      : amountRatio >= 0.85 && amountRatio <= 1.15);
  const hasCloseDate = dateDiffDays != null && dateDiffDays <= (isReceiptSearchWorker ? 75 : 120);
  const hasStrongAmountAndDateEvidence = hasStrongAmountMatch && hasCloseDate;

  if (filePartner && txName) {
    // Clean the transaction name (remove bank prefixes)
    const cleanTxName = txName
      .replace(/^(Tbl\*|To |From |SEPA |Überweisung |Lastschrift )/i, "")
      .replace(/\.{3}$/, "")
      .trim();

    const hasNameMismatch = !doNamesMatch(filePartner, cleanTxName);
    const shouldCheckPartnerMismatch = hasNameMismatch && (!isReceiptSearchWorker || hasTrustedPartnerReference);
    const shouldBlockOnPartnerMismatch = shouldCheckPartnerMismatch
      && !hasStrongAmountAndDateEvidence
      && !hasVeryStrongAmountMatch;

    if (shouldBlockOnPartnerMismatch) {
      warnings.push(
        `PARTNER MISMATCH: File is from "${filePartner}" but transaction is "${cleanTxName}". ` +
        `This file may not belong to this transaction.`
      );
    }
  }

  if (warnings.length === 0) return null;

  // If there are warnings, return them instead of connecting
  return {
    error: "VALIDATION_FAILED",
    warnings,
    fileId,
    transactionId,
    fileName: file.fileName,
    extractedPartner: file.extractedPartner || null,
    // Integer cents, as every amount the chat reads (#616).
    extractedAmount: fileAmount ?? null,
    extractedCurrency: file.extractedCurrency || "EUR",
    transactionName: tx.name,
    transactionAmount: tx.amount ?? null,
    transactionCurrency: tx.currency || "EUR",
    message: isReceiptSearchWorker
      ? `Cannot connect in receipt_search mode: ${warnings.join(" ")} Continue searching and verify another candidate.`
      : `Cannot connect: ${warnings.join(" ")} Use skipValidation=true to force connection.`,
  };
}

/** How the agent found the File, recorded on the File Connection for the Partner to learn from. */
export function agentSourceInfo(file: Data, args: AgentConnectArgs) {
  const sourceType = typeof args.sourceType === "string" && args.sourceType ? args.sourceType : undefined;
  const searchQuery = typeof args.searchQuery === "string" && args.searchQuery ? args.searchQuery : undefined;

  const inferredSourceType = sourceType || (
    file.sourceType === "gmail_html_invoice"
      ? "gmail_email"
      : file.sourceType === "gmail" || file.sourceType === "gmail_invoice_link"
        ? "gmail_attachment"
        : file.sourceType === "browser"
          ? "browser"
          : "local"
  );

  const gmailMessageFrom = (file.gmailSenderEmail || file.gmailMessageFrom || undefined) as string | undefined;
  const gmailIntegrationId = (file.gmailIntegrationId || undefined) as string | undefined;
  const effectiveSearchPattern = (searchQuery || file.sourceSearchPattern || undefined) as string | undefined;
  const effectiveResultType = (file.sourceResultType ||
    (inferredSourceType === "gmail_email"
      ? "gmail_html_invoice"
      : inferredSourceType === "gmail_attachment"
        ? "gmail_attachment"
        : inferredSourceType === "browser"
          ? "browser_invoice"
          : "local_file")) as string;

  return {
    sourceType: inferredSourceType,
    searchPattern: effectiveSearchPattern,
    gmailIntegrationId,
    gmailMessageFrom,
    resultType: effectiveResultType,
  };
}

/** The workers that may take automated File Connections apart to make room. */
export function agentMayReplaceAutomated(workerType: string | null): boolean {
  return workerType === "receipt_search" || workerType === "partner_file_batch";
}

/** The confidence the agent connects at; the chat sent `confidence || null`. */
export function agentConfidence(args: AgentConnectArgs): number | null {
  return typeof args.confidence === "number" && Number.isFinite(args.confidence) && args.confidence
    ? args.confidence
    : null;
}
