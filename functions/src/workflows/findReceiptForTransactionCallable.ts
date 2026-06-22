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

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import {
  searchGmailDirect,
  tryRefreshToken,
  type EmailTokenDocument,
  type GmailMessageResult,
} from "../gmail/searchGmailCallable";
import { defineSecret } from "firebase-functions/params";
import {
  findReceiptForTransaction,
  type FindReceiptResult,
  type GmailSearchMessage,
  type SearchGmailArgs,
} from "./findReceiptForTransaction";

// Secrets required for Gmail token refresh (mirrors searchGmailCallable)
const googleClientId = defineSecret("GOOGLE_CLIENT_ID");
const googleClientSecret = defineSecret("GOOGLE_CLIENT_SECRET");
const tokenEncryptionKey = defineSecret("TOKEN_ENCRYPTION_KEY");

interface FindReceiptCallableRequest {
  transactionId: string;
  /** Override score threshold for auto-connect (default 70). */
  autoConnectThreshold?: number;
  /** Override score floor below which candidates are dropped (default 35). */
  candidateFloor?: number;
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
    const { transactionId, ...thresholds } = request;
    if (!transactionId) {
      throw new HttpsError("invalid-argument", "transactionId is required");
    }

    const result = await findReceiptForTransaction(
      { transactionId, userId: ctx.userId, ...thresholds },
      {
        db: ctx.db,
        searchGmail: (args) => searchGmailForWorkflow(ctx.db, args),
        connectFileToTransaction: async ({ fileId, transactionId, matchConfidence, connectionType }) => {
          // Minimal inline connect for agent-initiated auto-connects.
          // Pattern learning + worker cancellation side effects are intentionally
          // skipped here (the user can re-run partner matching / receipt-search
          // automation manually). We do enough to mark the transaction complete
          // and create the connection record that the UI relies on.
          const now = Timestamp.now();
          await ctx.db.collection("transactions").doc(transactionId).update({
            fileIds: FieldValue.arrayUnion(fileId),
            isComplete: true,
            updatedAt: now,
          });
          await ctx.db.collection("files").doc(fileId).update({
            transactionIds: FieldValue.arrayUnion(transactionId),
            updatedAt: now,
          });
          await ctx.db.collection("fileConnections").add({
            fileId,
            transactionId,
            userId: ctx.userId,
            connectionType,
            matchConfidence,
            createdAt: now,
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
