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
 *   - Scores the user's stored Files with the matcher (#588): the same scorer and
 *     input assembly as the matching trigger, so a File's Confidence here is the
 *     one its suggestion list shows
 *   - Searches Gmail across the user's active integrations (if any), scores attachments
 *     and detects email-as-invoice candidates. Those are not Files yet, so the
 *     attachment scorer ranks them, and they are never auto-connected
 *   - Picks the best candidate; if it's a stored File at the matcher's auto threshold
 *     with a clear lead and no tie on the File's side (#667), auto-connects through
 *     the real connect path; otherwise
 *     surfaces top candidates for review (so the chat agent / UI / MCP caller can
 *     chain `downloadGmailAttachment` + `connectFileToTransaction` after user confirm)
 *
 * Dependency injection (searchGmail, connectFileToTransaction) keeps the workflow
 * unit-testable and lets the same code run from a callable Cloud Function or from
 * a worker context.
 */

import type { Firestore } from "firebase-admin/firestore";
import {
  scoreAttachmentMatch,
  ScoreAttachmentInput,
} from "../precision-search/scoreAttachmentMatch";
import {
  generateTypedSearchQueries,
  QueryGenerationPartner,
} from "../precision-search/generateSearchQueries";
import { readBankOriginalAmount } from "../fx/bankOriginalAmount";
import { autoConnectTies, filesForTransaction } from "../matching/matcher";
import { SCORING_CONFIG } from "../matching/transactionScoring";

/**
 * Below this a Gmail candidate is not surfaced. On the attachment scorer's
 * scale, which is not the matcher's: it only ranks mail against mail and
 * against stored Files for review, and never connects anything.
 */
const GMAIL_CANDIDATE_FLOOR = 35;

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
  connectionType: "auto_matched";
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

/**
 * Whether the File ties on this Transaction at the threshold (#667): another
 * uncovered Transaction of the same amount wants it as much. Judged on the
 * File's own matches, as the upload trigger judges them, so a tie connects
 * nothing from this side either.
 */
async function tiesOn(db: Firestore, userId: string, fileId: string, transactionId: string): Promise<boolean> {
  const snap = await db.collection("files").doc(fileId).get();
  if (!snap.exists || snap.data()?.userId !== userId) return false;
  const ties = await autoConnectTies(db, userId, [{ id: fileId, data: snap.data()! }]);
  return ties.get(fileId)?.has(transactionId) ?? false;
}

export async function findReceiptForTransaction(
  options: FindReceiptOptions,
  deps: FindReceiptDeps
): Promise<FindReceiptResult> {
  const { transactionId, userId } = options;
  // One line for stored Files, whoever calls (#588): the matcher's own.
  const autoConnectThreshold = SCORING_CONFIG.AUTO_MATCH_THRESHOLD;
  const suggestionThreshold = SCORING_CONFIG.SUGGESTION_THRESHOLD;
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

  const baseScoringContext: Pick<
    ScoreAttachmentInput,
    | "transactionAmount"
    | "transactionOriginalAmount"
    | "transactionDate"
    | "transactionName"
    | "transactionReference"
    | "transactionPartner"
    | "transactionPartnerId"
  > = {
    transactionAmount,
    // #555: the email states the charge in its own currency.
    transactionOriginalAmount:
      readBankOriginalAmount(tx._original?.rawRow)?.amount ?? null,
    transactionDate,
    transactionName,
    transactionReference,
    transactionPartner,
    transactionPartnerId,
  };

  // --- Score stored Files ---
  // The matcher, not the attachment scorer: currency, the bank-stated original
  // amount, the tip, Partner aliases and learned weights all count, and its
  // eligibility rule and date window decide which Files are possible (#613).
  const candidates: FindReceiptCandidate[] = [];
  const stored = await filesForTransaction(db, userId, txSnap);
  const localFileCount = stored.totalCandidates;

  for (const match of stored.matches) {
    if (match.confidence < suggestionThreshold) break;
    candidates.push({
      source: "local_file",
      score: match.confidence,
      label: match.confidence >= autoConnectThreshold ? "Strong" : "Likely",
      reasons: match.matchSources,
      fileId: match.fileId,
    });
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
    // that matches no real email.
    let partnerForGenerator: QueryGenerationPartner | undefined;
    if (transactionPartnerId) {
      try {
        const partnerSnap = await db
          .collection("partners")
          .doc(transactionPartnerId)
          .get();
        if (partnerSnap.exists) {
          const p = partnerSnap.data()!;
          let websiteHost: string | undefined;
          try {
            const raw = (p.website as string | undefined) ?? "";
            if (raw) websiteHost = new URL(raw).host.replace(/^www\./, "");
          } catch {
            // ignore malformed website URL
          }
          partnerForGenerator = {
            name: (p.name as string | undefined) ?? undefined,
            emailDomains: (p.emailDomains as string[] | undefined) ?? undefined,
            website: websiteHost,
            ibans: (p.ibans as string[] | undefined) ?? undefined,
            vatId: (p.vatId as string | undefined) ?? undefined,
            aliases: (p.aliases as string[] | undefined) ?? undefined,
            fileSourcePatterns:
              (p.fileSourcePatterns as
                | QueryGenerationPartner["fileSourcePatterns"]
                | undefined) ?? undefined,
          };
        }
      } catch (err) {
        console.warn(
          `[findReceiptForTransaction] failed to load partner ${transactionPartnerId}:`,
          err,
        );
      }
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

    // De-dupe and combine the top suggestions into one Gmail OR-query.
    // (Gmail's search syntax supports OR natively; one call costs one
    // rate-limit slot regardless of how many alternatives we OR together.)
    const queryTerms = Array.from(
      new Set(suggestions.map((s) => s.query).filter((q) => q.length >= 2)),
    );

    if (queryTerms.length > 0) {
      // Wrap free-text terms in parens so multi-word strings ("netflix
      // invoice") behave as a single OR clause. Gmail operator terms like
      // `from:netflix.com` must NOT be wrapped — they'd be treated as
      // literal text. Detect a colon → operator.
      const formatted = queryTerms.map((q) =>
        q.includes(":") ? q : q.includes(" ") ? `(${q})` : q,
      );
      const query = formatted.join(" OR ");

      const dateFrom = transactionDate
        ? new Date(transactionDate.getTime() - 180 * 24 * 3600_000).toISOString()
        : undefined;
      const dateTo = transactionDate
        ? new Date(transactionDate.getTime() + 45 * 24 * 3600_000).toISOString()
        : undefined;

      const gmail = await searchGmail({
        userId,
        integrationIds: activeIntegrationIds,
        query,
        dateFrom,
        dateTo,
        hasAttachments: false,
        limit: 30,
      });

      for (const message of gmail.messages) {
        gmailEmailCount++;
        const emailContext: Pick<
          ScoreAttachmentInput,
          | "emailSubject"
          | "emailFrom"
          | "emailSnippet"
          | "emailBodyText"
          | "emailDate"
          | "integrationId"
          | "classification"
        > = {
          emailSubject: message.subject,
          emailFrom: message.from,
          emailSnippet: message.snippet,
          emailBodyText: message.bodyText,
          emailDate: message.date ? new Date(message.date) : null,
          integrationId: message.integrationId,
          classification: message.classification ?? null,
        };

        for (const att of message.attachments) {
          gmailAttachmentCount++;
          const result = scoreAttachmentMatch({
            ...baseScoringContext,
            ...emailContext,
            filename: att.filename,
            mimeType: att.mimeType,
          });
          if (result.score >= GMAIL_CANDIDATE_FLOOR) {
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
          const result = scoreAttachmentMatch({
            ...baseScoringContext,
            ...emailContext,
            filename: `${message.subject || "email"}.pdf`,
            mimeType: "application/pdf",
          });
          if (result.score >= GMAIL_CANDIDATE_FLOOR) {
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

  // Only stored Files are auto-connected. Gmail candidates require a download
  // step (and async extraction verification) which the caller orchestrates.
  // An over-quota Transaction takes no automated connect; the connect path
  // would refuse it.
  if (
    isClearWinner &&
    top.source === "local_file" &&
    top.fileId &&
    !tx.quotaExceeded &&
    !(await tiesOn(db, userId, top.fileId, transactionId))
  ) {
    await connectFileToTransaction({
      userId,
      transactionId,
      fileId: top.fileId,
      matchConfidence: top.score,
      connectionType: "auto_matched",
    });
    return {
      status: "connected",
      fileId: top.fileId,
      confidence: top.score,
      sourcesChecked,
    };
  }

  const surfaced = candidates.slice(0, maxCandidates);
  await Promise.all(
    surfaced
      .filter((c) => c.source === "local_file" && c.fileId)
      .map(async (c) => {
        const fileSnap = await db.collection("files").doc(c.fileId!).get();
        c.filename = (fileSnap.data()?.fileName as string | undefined) ?? undefined;
      })
  );

  return {
    status: "needs_review",
    candidates: surfaced,
    sourcesChecked,
  };
}
