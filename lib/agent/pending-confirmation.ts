/**
 * Server-side binding of a tool confirmation to the call the agent proposed.
 *
 * /api/agent pauses before a tool that needs the user's yes. The browser
 * then answers with a confirmation, and before this the answer carried the
 * tool name and arguments itself: whatever the client sent was run, whether
 * or not the model ever proposed it. The client also sends the whole message
 * history, so the history cannot vouch for the proposal either.
 *
 * So the server keeps the proposal. When the graph pauses, issueConfirmation
 * stores { userId, toolName, toolCallId, args } under the hash of a fresh
 * random token and hands the token to the client. The confirmation presents
 * the token; consumeConfirmation reads the record and deletes it in one
 * transaction, and only what the server stored is run. Unknown, expired,
 * already used, or another user's token: nothing runs.
 *
 * The collection is unlisted in the client data policy, so only the server
 * can read or write it (same pattern as lib/gmail/oauth-state.ts).
 */

import crypto from "crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import { TOOLS_REQUIRING_CONFIRMATION } from "./tools";

const COLLECTION = "agentConfirmations";
const TTL_MS = 30 * 60 * 1000;

export interface PendingToolCall {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
}

function keyOf(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function issueConfirmation(userId: string, pending: PendingToolCall): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  await getAdminDb()
    .collection(COLLECTION)
    .doc(keyOf(token))
    .set({
      userId,
      toolName: pending.toolName,
      toolCallId: pending.toolCallId,
      // Stored as text: tool arguments are model output, and their keys are
      // not ours to vouch for as document field names.
      args: JSON.stringify(pending.args ?? {}),
      expiresAt: Timestamp.fromMillis(Date.now() + TTL_MS),
    });
  return token;
}

/** The proposal this token stands for, once, for the user it was issued to. */
export async function consumeConfirmation(token: unknown, userId: string): Promise<PendingToolCall | null> {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token) || !userId) return null;
  const db = getAdminDb();
  const ref = db.collection(COLLECTION).doc(keyOf(token));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data()!;
    // Someone else's token is left in place for its owner rather than burned.
    if (data.userId !== userId) return null;
    tx.delete(ref);
    const expiresAt = data.expiresAt as Timestamp | undefined;
    if (!expiresAt || expiresAt.toMillis() < Date.now()) return null;
    if (!TOOLS_REQUIRING_CONFIRMATION.includes(data.toolName)) return null;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(String(data.args ?? "{}"));
    } catch {
      return null;
    }
    return { toolName: data.toolName, toolCallId: String(data.toolCallId ?? ""), args };
  });
}
