/**
 * Find Receipt For Transaction — deterministic workflow.
 *
 * Encodes the "find a receipt and connect it" strategy as TypeScript instead
 * of as a prompt recipe. The chat agent, MCP tools, and A2A connectors all
 * invoke this single workflow so the secret-sauce strategy is identical
 * across channels.
 *
 * Scope of this version:
 *   - Pulls the transaction + checks short-circuits (already connected, no-receipt category)
 *   - Searches local files owned by the user, scores each candidate
 *   - Searches Gmail across the user's active integrations (if any), scores attachments
 *     and detects email-as-invoice candidates
 *   - Picks the best candidate; if it's a local file with a clear lead, auto-connects;
 *     otherwise surfaces top candidates for review (so the chat agent / UI / MCP caller
 *     can chain `downloadGmailAttachment` + `connectFileToTransaction` after user confirm)
 *
 * Dependency injection (searchGmail, connectFileToTransaction) keeps the workflow
 * unit-testable and lets the same code run from a callable Cloud Function or from
 * a worker context.
 */

import type { Firestore } from "firebase-admin/firestore";
import {
  scoreAttachments,
  type ScoreAttachmentRequest,
} from "../precision-search/scoreAttachmentMatchCallable";
import {
  generateTypedSearchQueries,
  QueryGenerationPartner,
} from "../precision-search/generateSearchQueries";

export type FindReceiptStatus =
  | "connected"
  | "needs_review"
  | "no_match"
  | "skipped";

export type FindReceiptSkipReason =
  | "already_has_file"
  | "has_no_receipt_category"
  | "transaction_not_found";

export type CandidateSource = "local_file" | "gmail_attachment" | "gmail_email";

export interface FindReceiptCandidate {
  source: CandidateSource;
  score: number;
  label: "Strong" | "Likely" | null;
  reasons: string[];
  /** Local file reference (source === "local_file") */
  fileId?: string;
  /** Gmail message reference (source === "gmail_*") */
  messageId?: string;
  /** Gmail attachment reference (source === "gmail_attachment") */
  attachmentId?: string;
  /** Gmail integration that owns the message */
  integrationId?: string;
  filename?: string;
  emailSubject?: string;
  emailFrom?: string;
}

export interface FindReceiptOptions {
  transactionId: string;
  userId: string;
  /** Score at/above which a clear top local-file winner is auto-connected (default 70). */
  autoConnectThreshold?: number;
  /** Minimum score for a candidate to be surfaced at all (default 35). */
  candidateFloor?: number;
  /** Minimum lead the top candidate must have over the runner-up to auto-connect (default 10). */
  clearLeadMargin?: number;
  /** Max candidates returned in needs_review (default 3). */
  maxCandidates?: number;
}

export interface FindReceiptResult {
  status: FindReceiptStatus;
  skipReason?: FindReceiptSkipReason;
  /** Set when status === "connected" */
  fileId?: string;
  /** Score of the auto-connected file (status === "connected") */
  confidence?: number;
  /** Top candidates for review when status === "needs_review" */
  candidates?: FindReceiptCandidate[];
  /** How many of each source we actually evaluated */
  sourcesChecked: {
    localFiles: number;
    gmailAttachments: number;
    gmailEmails: number;
  };
}

export interface SearchGmailArgs {
  userId: string;
  integrationIds: string[];
  query: string;
  dateFrom?: string;
  dateTo?: string;
  hasAttachments?: boolean;
  limit?: number;
}

export interface GmailSearchMessage {
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  bodyText: string | null;
  integrationId: string;
  attachments: Array<{
    attachmentId: string;
    filename: string;
    mimeType: string;
  }>;
  classification?: {
    hasPdfAttachment?: boolean;
    possibleMailInvoice?: boolean;
    possibleInvoiceLink?: boolean;
    confidence?: number;
  };
}

export interface ConnectFileArgs {
  userId: string;
  transactionId: string;
  fileId: string;
  matchConfidence: number;
  connectionType: string;
}

export interface FindReceiptDeps {
  db: Firestore;
  searchGmail: (args: SearchGmailArgs) => Promise<{ messages: GmailSearchMessage[] }>;
  connectFileToTransaction: (args: ConnectFileArgs) => Promise<{ fileId: string }>;
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (
    typeof value === "object" &&
    typeof (value as { toDate?: () => Date }).toDate === "function"
  ) {
    return (value as { toDate: () => Date }).toDate();
  }
  return null;
}

function emptySources(): FindReceiptResult["sourcesChecked"] {
  return { localFiles: 0, gmailAttachments: 0, gmailEmails: 0 };
}

export async function findReceiptForTransaction(
  options: FindReceiptOptions,
  deps: FindReceiptDeps
): Promise<FindReceiptResult> {
  const { transactionId, userId } = options;
  const autoConnectThreshold = options.autoConnectThreshold ?? 70;
  const candidateFloor = options.candidateFloor ?? 35;
  const clearLeadMargin = options.clearLeadMargin ?? 10;
  const maxCandidates = options.maxCandidates ?? 3;
  const { db, searchGmail, connectFileToTransaction } = deps;

  // --- Transaction lookup + short-circuits ---
  const txSnap = await db.collection("transactions").doc(transactionId).get();
  if (!txSnap.exists) {
    return {
      status: "skipped",
      skipReason: "transaction_not_found",
      sourcesChecked: emptySources(),
    };
  }
  const tx = txSnap.data()!;
  if (tx.userId !== userId) {
    return {
      status: "skipped",
      skipReason: "transaction_not_found",
      sourcesChecked: emptySources(),
    };
  }
  if (Array.isArray(tx.fileIds) && tx.fileIds.length > 0) {
    return {
      status: "skipped",
      skipReason: "already_has_file",
      sourcesChecked: emptySources(),
    };
  }
  if (tx.noReceiptCategoryId) {
    return {
      status: "skipped",
      skipReason: "has_no_receipt_category",
      sourcesChecked: emptySources(),
    };
  }

  // --- Transaction context for scoring ---
  const transactionAmount =
    typeof tx.amount === "number" ? (tx.amount as number) : null;
  const transactionDate = toDate(tx.date);
  const transactionName = (tx.name as string | null | undefined) ?? null;
  const transactionPartner =
    (tx.partner as string | null | undefined) ?? null;
  const transactionPartnerId =
    (tx.partnerId as string | null | undefined) ?? null;
  const transactionReference =
    (tx.reference as string | null | undefined) ?? null;

  // Resolve partner record up front so scoring can use its name, emailDomains
  // and learned patterns. Without these the scorer can only fuzzy-match the
  // bank-line text against email senders — for a tx with empty `partner`
  // string (older Firestore shape) it falls back to weak filename matching
  // and undershoots dramatically (~50% vs the UI's manual flow that scores
  // ~95% on the same files because it does pass partner data).
  let partnerRecord: FirebaseFirestore.DocumentData | null = null;
  if (transactionPartnerId) {
    try {
      const snap = await db
        .collection("partners")
        .doc(transactionPartnerId)
        .get();
      if (snap.exists) partnerRecord = snap.data() ?? null;
    } catch (err) {
      console.warn(
        `[findReceiptForTransaction] failed to load partner ${transactionPartnerId}:`,
        err,
      );
    }
  }

  const partnerName = (partnerRecord?.name as string | undefined) ?? null;
  const partnerEmailDomains =
    (partnerRecord?.emailDomains as string[] | undefined) ?? null;
  const partnerFileSourcePatterns =
    (partnerRecord?.fileSourcePatterns as
      | Array<{ sourceType: string; integrationId?: string }>
      | undefined) ?? null;

  // Build the (transaction, partner) halves of the score request once. Every
  // candidate gets paired with these to produce a single-attachment
  // ScoreAttachmentRequest dispatched through the shared scoreAttachments
  // helper. This is the exact same code path the UI's file-connect overlay uses,
  // so a given (tx, file) pair scores identically whether the agent or the
  // user triggers it.
  const transactionForRequest: ScoreAttachmentRequest["transaction"] = {
    amount: transactionAmount,
    date: transactionDate ? transactionDate.toISOString() : null,
    name: transactionName,
    reference: transactionReference,
    partner: transactionPartner,
    partnerId: transactionPartnerId,
  };
  const partnerForRequest: ScoreAttachmentRequest["partner"] = partnerRecord
    ? {
        name: partnerName,
        emailDomains: partnerEmailDomains,
        fileSourcePatterns: partnerFileSourcePatterns,
      }
    : null;

  function scoreOne(
    attachment: ScoreAttachmentRequest["attachments"][number],
  ) {
    const { scores } = scoreAttachments({
      attachments: [attachment],
      transaction: transactionForRequest,
      partner: partnerForRequest,
    });
    return scores[0];
  }

  // --- Score local files ---
  const candidates: FindReceiptCandidate[] = [];
  let localFileCount = 0;

  const filesSnap = await db
    .collection("files")
    .where("userId", "==", userId)
    .get();

  for (const fileDoc of filesSnap.docs) {
    const file = fileDoc.data();
    if (file.deletedAt) continue;
    // Skip files the AI classifier already flagged as not-an-invoice — they
    // have no extracted data to score against and surfacing them just makes
    // the agent burn round-trips on getFile only to discard them.
    if (file.isNotInvoice === true) continue;
    const fileTxIds = Array.isArray(file.transactionIds)
      ? (file.transactionIds as string[])
      : [];
    if (fileTxIds.includes(transactionId)) continue;
    localFileCount++;

    const fileExtractedDate = toDate(file.extractedDate);
    const result = scoreOne({
      key: fileDoc.id,
      filename: (file.fileName as string) ?? "",
      mimeType: (file.fileType as string) ?? "application/pdf",
      fileExtractedAmount:
        typeof file.extractedAmount === "number"
          ? (file.extractedAmount as number)
          : null,
      fileExtractedDate: fileExtractedDate
        ? fileExtractedDate.toISOString()
        : null,
      fileExtractedPartner:
        (file.extractedPartner as string | null | undefined) ?? null,
      filePartnerId: (file.partnerId as string | null | undefined) ?? null,
    });

    if (result.score >= candidateFloor) {
      candidates.push({
        source: "local_file",
        score: result.score,
        label: result.label,
        reasons: result.reasons,
        fileId: fileDoc.id,
        filename: (file.fileName as string) ?? undefined,
      });
    }
  }

  // --- Score Gmail attachments + emails ---
  let gmailAttachmentCount = 0;
  let gmailEmailCount = 0;

  const integrationsSnap = await db
    .collection("emailIntegrations")
    .where("userId", "==", userId)
    .where("provider", "==", "gmail")
    .where("isActive", "==", true)
    .get();

  const activeIntegrationIds = integrationsSnap.docs
    .filter((d) => !d.data().needsReauth)
    .map((d) => d.id);

  if (activeIntegrationIds.length > 0) {
    // Build smart search queries via the same generator the UI/agent uses,
    // so Gmail gets useful queries (invoice numbers, company names, sender
    // domains) instead of raw bank-line text like "Google Cloud Sbcq95"
    // that matches no real email. Reuses the partner record we already
    // loaded above for scoring.
    let partnerForGenerator: QueryGenerationPartner | undefined;
    if (partnerRecord) {
      let websiteHost: string | undefined;
      try {
        const raw = (partnerRecord.website as string | undefined) ?? "";
        if (raw) websiteHost = new URL(raw).host.replace(/^www\./, "");
      } catch {
        // ignore malformed website URL
      }
      partnerForGenerator = {
        name: (partnerRecord.name as string | undefined) ?? undefined,
        emailDomains:
          (partnerRecord.emailDomains as string[] | undefined) ?? undefined,
        website: websiteHost,
        ibans: (partnerRecord.ibans as string[] | undefined) ?? undefined,
        vatId: (partnerRecord.vatId as string | undefined) ?? undefined,
        aliases:
          (partnerRecord.aliases as string[] | undefined) ?? undefined,
        fileSourcePatterns:
          (partnerRecord.fileSourcePatterns as
            | QueryGenerationPartner["fileSourcePatterns"]
            | undefined) ?? undefined,
      };
    }

    const suggestions = generateTypedSearchQueries(
      {
        name: transactionName ?? "",
        partner: transactionPartner,
        description: (tx.description as string | undefined) ?? undefined,
        reference: transactionReference ?? undefined,
      },
      partnerForGenerator,
      // Cap at 4 so we don't fan out too many Gmail calls. The generator
      // sorts by score so we get the highest-signal ones (invoice numbers,
      // company names, sender domains) first.
      4,
    );

    // If the partner has known-good past patterns (recorded on prior
    // successful matches), use those FIRST. They're the cheapest hit:
    // we already learned they work for this partner, no need to burn
    // queries discovering them again. Sorted by usageCount so the most
    // proven pattern goes first.
    const learnedQueries: string[] = [];
    if (partnerForGenerator?.fileSourcePatterns?.length) {
      const sorted = [...partnerForGenerator.fileSourcePatterns]
        .filter((p) => p.sourceType !== "local") // local = filename patterns, not Gmail queries
        .sort((a, b) => {
          if ((b.usageCount ?? 0) !== (a.usageCount ?? 0))
            return (b.usageCount ?? 0) - (a.usageCount ?? 0);
          return (b.confidence ?? 0) - (a.confidence ?? 0);
        })
        .slice(0, 3);
      for (const p of sorted) {
        if (p.pattern && p.pattern.length >= 2) learnedQueries.push(p.pattern);
      }
    }

    // De-dupe: learned queries first (highest priority), then generator
    // suggestions. Order matters — the search loop runs sequentially with
    // an early-exit on coverage, so cheaper proven queries should come
    // first.
    const queryTerms = Array.from(
      new Set([
        ...learnedQueries,
        ...suggestions.map((s) => s.query).filter((q) => q.length >= 2),
      ]),
    );

    if (queryTerms.length > 0) {
      const dateFrom = transactionDate
        ? new Date(transactionDate.getTime() - 180 * 24 * 3600_000).toISOString()
        : undefined;
      const dateTo = transactionDate
        ? new Date(transactionDate.getTime() + 45 * 24 * 3600_000).toISOString()
        : undefined;

      // Run queries sequentially. Gmail enforces a per-user concurrent
      // request cap (~ a handful of in-flight calls); each searchGmailDirect
      // already fans out internally (one fetch per matching message) so
      // firing N queries in parallel multiplies that and reliably trips
      // the 429 rateLimitExceeded. The old wand recipe was also sequential
      // because each tool call ran one at a time through the LLM.
      const merged = new Map<string, GmailSearchMessage>();
      for (const q of queryTerms) {
        // If we already have ample coverage, stop early — additional queries
        // mostly return duplicates and waste rate-limit budget.
        if (merged.size >= 50) break;
        try {
          const r = await searchGmail({
            userId,
            integrationIds: activeIntegrationIds,
            query: q,
            dateFrom,
            dateTo,
            hasAttachments: false,
            limit: 30,
          });
          for (const m of r.messages) {
            if (!merged.has(m.messageId)) merged.set(m.messageId, m);
          }
        } catch (err) {
          console.warn(
            `[findReceiptForTransaction] Gmail query ${JSON.stringify(q)} failed:`,
            err,
          );
        }
      }
      const gmail = { messages: Array.from(merged.values()) };

      for (const message of gmail.messages) {
        gmailEmailCount++;
        const emailContext = {
          emailSubject: message.subject,
          emailFrom: message.from,
          emailSnippet: message.snippet,
          emailBodyText: message.bodyText,
          emailDate: message.date || null,
          integrationId: message.integrationId,
          classification: message.classification ?? null,
        };

        for (const att of message.attachments) {
          gmailAttachmentCount++;
          const result = scoreOne({
            key: `${message.messageId}:${att.attachmentId}`,
            ...emailContext,
            filename: att.filename,
            mimeType: att.mimeType,
          });
          if (result.score >= candidateFloor) {
            candidates.push({
              source: "gmail_attachment",
              score: result.score,
              label: result.label,
              reasons: result.reasons,
              messageId: message.messageId,
              attachmentId: att.attachmentId,
              integrationId: message.integrationId,
              filename: att.filename,
              emailSubject: message.subject,
              emailFrom: message.from,
            });
          }
        }

        // Email-as-invoice path: no PDF attachment but the email itself looks like an invoice.
        if (
          message.attachments.length === 0 &&
          message.classification?.possibleMailInvoice
        ) {
          const result = scoreOne({
            key: `${message.messageId}:email`,
            ...emailContext,
            filename: `${message.subject || "email"}.pdf`,
            mimeType: "application/pdf",
          });
          if (result.score >= candidateFloor) {
            candidates.push({
              source: "gmail_email",
              score: result.score,
              label: result.label,
              reasons: result.reasons,
              messageId: message.messageId,
              integrationId: message.integrationId,
              emailSubject: message.subject,
              emailFrom: message.from,
            });
          }
        }
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const sourcesChecked = {
    localFiles: localFileCount,
    gmailAttachments: gmailAttachmentCount,
    gmailEmails: gmailEmailCount,
  };

  if (candidates.length === 0) {
    return { status: "no_match", sourcesChecked };
  }

  const top = candidates[0];
  const second = candidates[1];
  const isClearWinner =
    top.score >= autoConnectThreshold &&
    (!second || top.score - second.score >= clearLeadMargin);

  // Only local files are auto-connected. Gmail candidates require a download
  // step (and async extraction verification) which the caller orchestrates.
  if (isClearWinner && top.source === "local_file" && top.fileId) {
    await connectFileToTransaction({
      userId,
      transactionId,
      fileId: top.fileId,
      matchConfidence: top.score,
      connectionType: "agent_auto",
    });
    return {
      status: "connected",
      fileId: top.fileId,
      confidence: top.score,
      sourcesChecked,
    };
  }

  return {
    status: "needs_review",
    candidates: candidates.slice(0, maxCandidates),
    sourcesChecked,
  };
}
