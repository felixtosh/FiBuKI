/**
 * Server-side binding of a choice to what the agent proposed.
 *
 * The chat hands the User a decision in two ways (lib/agent/choices.ts): a
 * write that waits for Approve / Cancel, and presentChoices options that each
 * carry the write they stand for. The browser answers with a click, and the
 * client also sends the whole message history, so neither the click nor the
 * history can vouch for what runs: whatever the client sent would be run,
 * whether or not the model ever proposed it.
 *
 * So the server keeps the proposal. When the tools node pauses on a choice,
 * issueChoice stores { userId, toolCallId, options } under the hash of a fresh
 * random token and hands the token to the client inside the tool result. The
 * click presents the token and an option id; consumeChoice reads the record
 * and deletes it in one transaction, and only the option the server stored is
 * run. Unknown, expired, already used, or another user's token: nothing runs.
 *
 * The collection is unlisted in the client data policy, so only the server
 * can read or write it (same pattern as lib/gmail/oauth-state.ts).
 */

import crypto from "crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import { isChoiceActionTool, requiresConfirmation, type ChoiceOption } from "./choices";

const COLLECTION = "agentConfirmations";
const TTL_MS = 24 * 60 * 60 * 1000;

export interface PendingChoice {
  kind: "confirmation" | "choice";
  toolCallId: string;
  options: ChoiceOption[];
}

function keyOf(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function issueChoice(userId: string, pending: PendingChoice): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  await getAdminDb()
    .collection(COLLECTION)
    .doc(keyOf(token))
    .set({
      userId,
      kind: pending.kind,
      toolCallId: pending.toolCallId,
      // Stored as text: tool arguments are model output, and their keys are
      // not ours to vouch for as document field names.
      options: JSON.stringify(pending.options ?? []),
      expiresAt: Timestamp.fromMillis(Date.now() + TTL_MS),
    });
  return token;
}

/** An option may run only a write its kind allows: a confirmation its own gated tool, a choice the click list. */
function mayRun(kind: string, option: ChoiceOption): boolean {
  if (!option.action) return true;
  return kind === "confirmation" ? requiresConfirmation(option.action.tool) : isChoiceActionTool(option.action.tool);
}

/** The option this token and id stand for, once, for the user it was issued to. */
export async function consumeChoice(
  token: unknown,
  userId: string,
  optionId: string
): Promise<{ kind: PendingChoice["kind"]; toolCallId: string; option: ChoiceOption | null } | null> {
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
    const kind = data.kind === "confirmation" ? "confirmation" : "choice";
    let options: ChoiceOption[];
    try {
      options = JSON.parse(String(data.options ?? "[]"));
    } catch {
      return null;
    }
    const option = options.find((o) => o?.id === optionId) ?? null;
    if (option && !mayRun(kind, option)) return null;
    return { kind, toolCallId: String(data.toolCallId ?? ""), option };
  });
}
