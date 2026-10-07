/**
 * Disconnect a file from a transaction: the callable surface of the File
 * Connection writer's Unlink (#612).
 */

import { createCallable } from "../utils/createCallable";
import { unlinkFile } from "../fileConnections/writer";

interface DisconnectFileRequest {
  fileId: string;
  transactionId: string;
  /** If true, adds the file to transaction's rejectedFileIds to prevent auto-reconnection */
  rejectFile?: boolean;
}

interface DisconnectFileResponse {
  success: boolean;
}

/**
 * The disconnect itself, shared by the callable and the tool surface (#584).
 */
export async function performDisconnectFile(
  db: FirebaseFirestore.Firestore,
  userId: string,
  request: DisconnectFileRequest,
  /** Who disconnects, for the activity log (#752): the tool surface passes `ai`. */
  actor: "manual" | "ai" = "manual"
): Promise<DisconnectFileResponse> {
  await unlinkFile(db, userId, {
    fileId: request?.fileId,
    transactionId: request?.transactionId,
    reject: request?.rejectFile === true,
    actor,
  });
  return { success: true };
}

export const disconnectFileFromTransactionCallable = createCallable<
  DisconnectFileRequest,
  DisconnectFileResponse
>({ name: "disconnectFileFromTransaction" }, (ctx, request) =>
  performDisconnectFile(ctx.db, ctx.userId, request)
);
