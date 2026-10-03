/**
 * The Copy acts (#162, ADR-0010) behind the UI: mark a File as a Copy of
 * another, "Not a Copy" (undo or decline), and "Make this the original".
 * Each checks that the user owns every File id it is given; the state
 * transitions themselves live in copyOps, shared with the MCP tools.
 *
 * Also the one-time pass over Files that predate the Copy check. It only
 * suggests: nothing is recorded or unlinked until a person accepts.
 */

import { createCallable } from "../utils/createCallable";
import {
  markFileAsCopy,
  unmarkFileAsCopy,
  makeFileTheOriginal,
  backfillCopySuggestions,
  type MarkCopyResult,
  type NotACopyResult,
  type MakeOriginalResult,
  type BackfillCopySuggestionsResult,
} from "./copyOps";
import { runTransactionMatching } from "../matching/matchFileTransactions";

export const markFileAsCopyCallable = createCallable<
  { fileId: string; originalFileId: string },
  MarkCopyResult
>({ name: "markFileAsCopy" }, async (ctx, request) =>
  markFileAsCopy(ctx.db, ctx.userId, (request ?? {}) as Record<string, unknown>, "user")
);

/**
 * "Not a Copy", then the follow-up every surface owes it: an undone Copy goes
 * back to matching with fresh Matches, like any unconnected File. Shared by
 * the callable and the MCP tool.
 */
export async function unmarkFileAsCopyAndRematch(
  db: FirebaseFirestore.Firestore,
  userId: string,
  args: Record<string, unknown>
): Promise<NotACopyResult> {
  const result = await unmarkFileAsCopy(db, userId, args);
  if (result.outcome === "undone") {
    const snap = await db.collection("files").doc(result.fileId).get();
    if (snap.exists) {
      try {
        await runTransactionMatching(result.fileId, snap.data()!);
      } catch (err) {
        console.error(`[unmarkFileAsCopy] Matching failed for ${result.fileId}`, err);
      }
    }
  }
  return result;
}

export const unmarkFileAsCopyCallable = createCallable<{ fileId: string }, NotACopyResult>(
  { name: "unmarkFileAsCopy" },
  async (ctx, request) =>
    unmarkFileAsCopyAndRematch(ctx.db, ctx.userId, (request ?? {}) as Record<string, unknown>)
);

export const makeFileTheOriginalCallable = createCallable<{ fileId: string }, MakeOriginalResult>(
  { name: "makeFileTheOriginal" },
  async (ctx, request) =>
    makeFileTheOriginal(ctx.db, ctx.userId, (request ?? {}) as Record<string, unknown>)
);

export const backfillCopySuggestionsCallable = createCallable<
  Record<string, never>,
  BackfillCopySuggestionsResult
>({ name: "backfillCopySuggestions", timeoutSeconds: 300 }, async (ctx) =>
  backfillCopySuggestions(ctx.db, ctx.userId)
);
