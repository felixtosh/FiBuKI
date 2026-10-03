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
        connectFileToTransaction: async ({ fileId, transactionId, matchConfidence, connectionType }) => {
          // The connect the UI makes, Copy refusal, Partner sync and learning
          // included.
          await performConnectFileToTransaction(ctx, {
            fileId,
            transactionId,
            connectionType,
            matchConfidence,
          });
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

function buildDateScopedQuery(query: string, dateFrom?: string, dateTo?: string): string {
  const parts = [query];
  if (dateFrom) {
    const d = new Date(dateFrom);
    parts.push(`after:${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`);
  }
  if (dateTo) {
    const d = new Date(dateTo);
    parts.push(`before:${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`);
  }
  return parts.filter(Boolean).join(" ");
}
