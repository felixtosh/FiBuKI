/**
 * Score one File against one Transaction, by id, for callers that live outside
 * the functions process (the chat agent's scoreBatchMatches tool).
 *
 * A thin wrapper on purpose: the scoring and its input assembly are the MCP
 * tool's (`score_file_transaction_match` in tools/handlers.ts), which uses the
 * same scorer as the matching trigger and the connect dialog. A second
 * assembly here is how the agent and the UI would come to disagree on a
 * score. Ownership of both ids is checked there, and either one missing or
 * foreign answers the same not-found.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import { scoreFileTransactionMatch } from "../tools/handlers";

interface ScoreFileTransactionMatchRequest {
  fileId: string;
  transactionId: string;
}

type ScoreFileTransactionMatchResponse = Awaited<ReturnType<typeof scoreFileTransactionMatch>>;

export const scoreFileTransactionMatchCallable = createCallable<
  ScoreFileTransactionMatchRequest,
  ScoreFileTransactionMatchResponse
>({ name: "scoreFileTransactionMatch" }, async (ctx, request) => {
  const { fileId, transactionId } = request ?? ({} as ScoreFileTransactionMatchRequest);
  if (typeof fileId !== "string" || !fileId || typeof transactionId !== "string" || !transactionId) {
    throw new HttpsError("invalid-argument", "fileId and transactionId are required");
  }
  try {
    return await scoreFileTransactionMatch(ctx.userId, { fileId, transactionId });
  } catch (err) {
    const message = (err as Error)?.message ?? "";
    if (message === "File not found" || message === "Transaction not found") {
      throw new HttpsError("not-found", "File or Transaction not found");
    }
    throw err;
  }
});
