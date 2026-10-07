/**
 * Cloud Function wrapper for the findReceiptForTransaction workflow.
 *
 * One callable, four personas:
 *   - UI button -> direct callable
 *   - Internal chat agent -> callable via tool
 *   - External MCP / REST -> exposed via tools handler
 *   - A2A connectors -> same callable
 *
 * The workflow library function lives in ./findReceiptForTransaction.ts and is
 * fully unit-tested with DI. This wrapper just provides production implementations
 * of the `searchGmail` and `connectFileToTransaction` dependencies.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import {
  isLikelyReceiptAttachment,
  searchGmailDirect,
  tryRefreshToken,
  type EmailTokenDocument,
  type GmailMessageResult,
} from "../gmail/searchGmailCallable";
import { defineSecret } from "firebase-functions/params";
import { performConnectFileToTransaction } from "../files/connectFileToTransaction";
import {
  findReceiptForTransaction,
  type FindReceiptResult,
  type GmailSearchMessage,
  type SearchGmailArgs,
} from "./findReceiptForTransaction";
import { dayOf } from "../utils/storedDay";
import type { MailProvider } from "../mail/provider";
import { mailProviderOf } from "../mail/searchable";
import { namedSearchTerms } from "../mail/search-terms";
import { mailProviderForIntegration, recordMailboxFailure } from "../mail/searchMailboxes";
import { classifyEmail } from "../precision-search/shared-utils";

// Secrets required for Gmail token refresh (mirrors searchGmailCallable)
const googleClientId = defineSecret("GOOGLE_CLIENT_ID");
const googleClientSecret = defineSecret("GOOGLE_CLIENT_SECRET");
const tokenEncryptionKey = defineSecret("GMAIL_TOKEN_ENCRYPTION_KEY");

interface FindReceiptCallableRequest {
  transactionId: string;
  /** Override lead margin required for auto-connect (default 10). */
  clearLeadMargin?: number;
  /** Max candidates returned in needs_review (default 3). */
  maxCandidates?: number;
}

export const findReceiptForTransactionCallable = createCallable<
  FindReceiptCallableRequest,
  FindReceiptResult
>(
  {
    name: "findReceiptForTransaction",
    memory: "512MiB",
    timeoutSeconds: 60,
    secrets: [googleClientId, googleClientSecret, tokenEncryptionKey],
  },
  async (ctx, request) => {
    // The auto-connect line and the candidate floor are the matcher's (#588),
    // so they are not read from the request: one line for stored Files,
    // whoever calls.
    const { transactionId, clearLeadMargin, maxCandidates } = request;
    if (!transactionId) {
      throw new HttpsError("invalid-argument", "transactionId is required");
    }

    const result = await findReceiptForTransaction(
      { transactionId, userId: ctx.userId, clearLeadMargin, maxCandidates },
      {
        db: ctx.db,
        searchGmail: (args) => searchGmailForWorkflow(ctx.db, args),
        connectFileToTransaction: async ({ fileId, transactionId, matchConfidence, connectionType, autoConnectReason }) => {
          // The connect the UI makes, Copy refusal, Partner sync and learning
          // included. The reason travels beside the request, never in it: the
          // callable's request takes none (#716).
          await performConnectFileToTransaction(
            ctx,
            { fileId, transactionId, connectionType, matchConfidence },
            autoConnectReason ? { autoConnectReason } : {}
          );
          return { fileId };
        },
      }
    );

    console.log(`[findReceiptForTransaction] result`, {
      userId: ctx.userId,
      transactionId,
      status: result.status,
      sourcesChecked: result.sourcesChecked,
      candidateCount: result.candidates?.length ?? 0,
    });

    return result;
  }
);

/**
 * Production implementation of the workflow's searchGmail dependency.
 * Loops over the provided integrations, refreshes tokens as needed,
 * and calls searchGmailDirect for each.
 */
async function searchGmailForWorkflow(
  db: FirebaseFirestore.Firestore,
  args: SearchGmailArgs
): Promise<{ messages: GmailSearchMessage[] }> {
  const collected: GmailSearchMessage[] = [];

  for (const integrationId of args.integrationIds) {
    const integrationRef = db.collection("emailIntegrations").doc(integrationId);
    const integrationSnap = await integrationRef.get();
    if (!integrationSnap.exists) continue;
    const integration = integrationSnap.data()!;
    if (integration.userId !== args.userId) continue;
    if (integration.needsReauth) continue;

    // Every mailbox but Gmail is read through its Mail Provider (#746).
    if (mailProviderOf(integration) !== "gmail") {
      collected.push(...(await searchMailboxForWorkflow(db, integrationId, integration, args)));
      continue;
    }

    const tokenSnap = await db.collection("emailTokens").doc(integrationId).get();
    if (!tokenSnap.exists) continue;
    let tokens = tokenSnap.data() as EmailTokenDocument;

    if (tokens.expiresAt.toDate() < new Date()) {
      const refreshed = await tryRefreshToken(integrationId, tokens, integrationRef);
      if (!refreshed) continue;
      tokens = { ...tokens, accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt };
    }

    try {
      const messages: GmailMessageResult[] = await searchGmailDirect({
        accessToken: tokens.accessToken,
        query: buildDateScopedQuery(args.query, args.dateFrom, args.dateTo),
        hasAttachments: args.hasAttachments,
        limit: args.limit,
      });

      for (const msg of messages) {
        collected.push({
          messageId: msg.messageId,
          threadId: msg.threadId,
          subject: msg.subject,
          from: msg.from,
          date: msg.date,
          snippet: msg.snippet,
          bodyText: msg.bodyText,
          integrationId,
          attachments: msg.attachments.map((a) => ({
            attachmentId: a.attachmentId,
            filename: a.filename,
            mimeType: a.mimeType,
          })),
          classification: msg.classification
            ? {
                hasPdfAttachment: msg.classification.hasPdfAttachment,
                possibleMailInvoice: msg.classification.possibleMailInvoice,
                possibleInvoiceLink: msg.classification.possibleInvoiceLink,
                confidence: msg.classification.confidence,
              }
            : undefined,
        });
      }
    } catch (err) {
      console.error(
        `[findReceiptForTransaction] Gmail search failed for integration ${integrationId}`,
        err
      );
    }
  }

  return { messages: collected };
}

/** Messages one Mail Provider search returns at most per suggestion. */
const PROVIDER_RESULTS_PER_TERMS = 10;

/**
 * The workflow's search over a mailbox that cannot read a Gmail query: one
 * provider search per suggestion's terms, the results merged. A refused login
 * marks the mailbox as needing new credentials, as the search queue does.
 */
async function searchMailboxForWorkflow(
  db: FirebaseFirestore.Firestore,
  integrationId: string,
  integration: FirebaseFirestore.DocumentData,
  args: SearchGmailArgs
): Promise<GmailSearchMessage[]> {
  const provider = mailProviderOf(integration);
  const dateTo = args.dateTo ? new Date(args.dateTo) : new Date();
  const dateFrom = args.dateFrom
    ? new Date(args.dateFrom)
    : new Date(dateTo.getTime() - 365 * 24 * 60 * 60 * 1000);
  const limit = Math.min(args.limit ?? 30, PROVIDER_RESULTS_PER_TERMS);
  const found: GmailSearchMessage[] = [];
  const seen = new Set<string>();

  let mail: MailProvider | null = null;
  try {
    mail = await mailProviderForIntegration(integrationId, integration);
    for (const raw of args.terms ?? []) {
      const terms = namedSearchTerms(raw);
      if (!terms) continue;
      const page = await mail.search({
        ...terms,
        hasAttachment: args.hasAttachments === true,
        dateFrom,
        dateTo,
        limit,
      });
      for (const ref of page.messages) {
        if (seen.has(ref.id)) continue;
        seen.add(ref.id);
        const message = await mail.getMessage(ref);
        const attachments = message.attachments.map((a) => ({
          attachmentId: a.attachmentId,
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
          isLikelyReceipt: isLikelyReceiptAttachment(a.filename, a.mimeType),
        }));
        const classification = classifyEmail(message.subject, message.snippet ?? "", attachments, null);
        found.push({
          messageId: message.id,
          // No threads outside Gmail; the message stands in for its own thread.
          threadId: message.id,
          subject: message.subject || "(No Subject)",
          from: message.from,
          date: message.date.toISOString(),
          snippet: message.snippet ?? "",
          bodyText: null,
          integrationId,
          attachments: attachments.map(({ attachmentId, filename, mimeType }) => ({ attachmentId, filename, mimeType })),
          classification: {
            hasPdfAttachment: classification.hasPdfAttachment,
            possibleMailInvoice: classification.possibleMailInvoice,
            possibleInvoiceLink: classification.possibleInvoiceLink,
            confidence: classification.confidence,
          },
        });
      }
    }
  } catch (err) {
    await recordMailboxFailure(db, integrationId, provider, err);
  } finally {
    await mail?.close().catch(() => undefined);
  }
  return found;
}

function buildDateScopedQuery(query: string, dateFrom?: string, dateTo?: string): string {
  const parts = [query];
  if (dateFrom) {
    parts.push(`after:${dayOf(new Date(dateFrom)).replace(/-/g, "/")}`);
  }
  if (dateTo) {
    parts.push(`before:${dayOf(new Date(dateTo)).replace(/-/g, "/")}`);
  }
  return parts.filter(Boolean).join(" ");
}
