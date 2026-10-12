/**
 * The chat's traces (lib/agent/trace.ts): the User's thumbs on a reply, and
 * the admin list the review page reads.
 *
 * `chatTraces/{userId}_{turnId}` is written by the web container's chat route
 * only, and is not in the client data policy. Feedback names a turn, and the
 * document id is built from the caller's own uid, so a User can only rate a
 * turn of their own. The list is for admins, decided from the verified token.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import { isAdminCaller } from "../utils/adminCaller";

const COLLECTION = "chatTraces";

export interface SubmitChatFeedbackRequest {
  turnId: string;
  rating: "up" | "down";
  comment?: string;
}

export const submitChatFeedbackCallable = createCallable<SubmitChatFeedbackRequest, { success: true }>(
  { name: "submitChatFeedback" },
  async (ctx, request) => {
    const turnId = request?.turnId;
    if (typeof turnId !== "string" || !/^[\w-]{8,64}$/.test(turnId)) {
      throw new HttpsError("invalid-argument", "turnId is required");
    }
    if (request.rating !== "up" && request.rating !== "down") {
      throw new HttpsError("invalid-argument", "rating must be up or down");
    }
    const comment = typeof request.comment === "string" ? request.comment.trim().slice(0, 2000) : "";
    const ref = ctx.db.collection(COLLECTION).doc(`${ctx.userId}_${turnId}`);
    const snap = await ref.get();
    // Another User's turn has another id; a turn that is not stored is "not found" either way.
    if (!snap.exists || snap.data()?.userId !== ctx.userId) {
      throw new HttpsError("not-found", "Turn not found");
    }
    await ref.update({
      feedback: { rating: request.rating, comment: comment || null, at: new Date().toISOString() },
    });
    return { success: true };
  }
);

export interface ListChatTracesRequest {
  limit?: number;
  /** Only turns the User rated, or only turns with a failed rubric check. */
  filter?: "all" | "feedback" | "failing";
}

export interface ChatTraceRow {
  id: string;
  userId: string;
  createdAt: string | null;
  provider: string;
  model: string;
  userMessage: string;
  finalText: string;
  steps: unknown[];
  verdicts: Record<string, string>;
  passRate: number | null;
  feedback: { rating: string; comment: string | null } | null;
  choice: unknown;
  durationMs: number;
  estimatedCost: number;
  error: string | null;
}

function toIso(value: unknown): string | null {
  const v = value as { toDate?: () => Date } | null;
  return v?.toDate ? v.toDate().toISOString() : null;
}

export const listChatTracesCallable = createCallable<ListChatTracesRequest, { traces: ChatTraceRow[] }>(
  { name: "listChatTraces" },
  async (ctx, request) => {
    if (!isAdminCaller(ctx.request.auth)) throw new HttpsError("permission-denied", "Admin access required");
    const limit = Math.min(Math.max(Number(request?.limit) || 100, 1), 500);
    const filter = request?.filter ?? "all";
    // The newest turns, filtered here: a filtered query would need an index per filter.
    const snap = await ctx.db
      .collection(COLLECTION)
      .orderBy("createdAt", "desc")
      .limit(filter === "all" ? limit : limit * 5)
      .get();
    const rows: ChatTraceRow[] = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        userId: String(d.userId ?? ""),
        createdAt: toIso(d.createdAt),
        provider: String(d.provider ?? ""),
        model: String(d.model ?? ""),
        userMessage: String(d.userMessage ?? ""),
        finalText: String(d.finalText ?? ""),
        steps: Array.isArray(d.steps) ? d.steps : [],
        verdicts: (d.verdicts ?? {}) as Record<string, string>,
        passRate: typeof d.passRate === "number" ? d.passRate : null,
        feedback: d.feedback ?? null,
        choice: d.choice ?? null,
        durationMs: Number(d.durationMs ?? 0),
        estimatedCost: Number(d.estimatedCost ?? 0),
        error: d.error ?? null,
      };
    });
    const kept =
      filter === "feedback"
        ? rows.filter((r) => r.feedback)
        : filter === "failing"
          ? rows.filter((r) => Object.values(r.verdicts).includes("fail"))
          : rows;
    return { traces: kept.slice(0, limit) };
  }
);
