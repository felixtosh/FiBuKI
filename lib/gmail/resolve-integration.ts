/**
 * Server-side resolver for Gmail integrations.
 *
 * Why: the chat agent shouldn't have to (and can't reliably) supply integrationId
 * — it tends to hallucinate IDs. Routes accept an optional integrationId from
 * trusted clients (UI), and fall back to probing the user's active Gmail
 * integrations for the given messageId.
 */
import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";

const INTEGRATIONS_COLLECTION = "emailIntegrations";
const TOKENS_COLLECTION = "emailTokens";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

export interface GmailIntegrationContext {
  integrationId: string;
  integration: FirebaseFirestore.DocumentData;
  accessToken: string;
  refreshToken: string;
}

export class GmailResolutionError extends Error {
  constructor(public code: string, message: string, public status = 403) {
    super(message);
  }
}

async function loadIntegrationContext(
  integrationId: string,
  userId: string
): Promise<GmailIntegrationContext> {
  const db = getAdminDb();
  const integrationRef = db.collection(INTEGRATIONS_COLLECTION).doc(integrationId);
  const snap = await integrationRef.get();

  if (!snap.exists) {
    throw new GmailResolutionError("INTEGRATION_NOT_FOUND", "Integration not found", 404);
  }
  const integration = snap.data()!;
  if (integration.userId !== userId) {
    throw new GmailResolutionError("INTEGRATION_NOT_FOUND", "Integration not found", 404);
  }
  if (integration.needsReauth) {
    throw new GmailResolutionError("REAUTH_REQUIRED", "Re-authentication required");
  }

  const tokenSnap = await db.collection(TOKENS_COLLECTION).doc(integrationId).get();
  if (!tokenSnap.exists) {
    throw new GmailResolutionError("TOKENS_MISSING", "Tokens not found. Please reconnect Gmail.");
  }
  const tokens = tokenSnap.data()!;

  if (tokens.expiresAt.toDate() < new Date()) {
    await integrationRef.update({
      needsReauth: true,
      lastError: "Access token expired",
      updatedAt: Timestamp.now(),
    });
    throw new GmailResolutionError("TOKEN_EXPIRED", "Access token expired. Please reconnect Gmail.");
  }

  return {
    integrationId,
    integration,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || "",
  };
}

/**
 * Resolve a Gmail integration when integrationId is known (trusted callers).
 * Returns context including a fresh access token. Throws GmailResolutionError on auth/ownership issues.
 */
export async function resolveIntegrationById(
  integrationId: string,
  userId: string
): Promise<GmailIntegrationContext> {
  return loadIntegrationContext(integrationId, userId);
}

/**
 * Resolve which of the user's active Gmail integrations owns a given messageId,
 * by probing each integration. Used when callers (e.g. chat agent) cannot supply
 * integrationId reliably. Stops at first hit.
 */
export async function resolveIntegrationByMessageId(
  messageId: string,
  userId: string
): Promise<GmailIntegrationContext> {
  const db = getAdminDb();
  const snap = await db
    .collection(INTEGRATIONS_COLLECTION)
    .where("userId", "==", userId)
    .where("provider", "==", "gmail")
    .where("isActive", "==", true)
    .get();

  if (snap.empty) {
    throw new GmailResolutionError(
      "NO_GMAIL_INTEGRATION",
      "Gmail is not connected. Connect Gmail to use this feature."
    );
  }

  const candidates = snap.docs.filter((d) => !d.data().needsReauth);
  if (candidates.length === 0) {
    throw new GmailResolutionError(
      "REAUTH_REQUIRED",
      "Gmail re-authentication required for all connected accounts."
    );
  }

  let lastError: GmailResolutionError | null = null;
  for (const doc of candidates) {
    let ctx: GmailIntegrationContext;
    try {
      ctx = await loadIntegrationContext(doc.id, userId);
    } catch (err) {
      if (err instanceof GmailResolutionError) {
        lastError = err;
        continue;
      }
      throw err;
    }

    const res = await fetch(
      `${GMAIL_API_BASE}/users/me/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=Message-ID`,
      { headers: { Authorization: `Bearer ${ctx.accessToken}` } }
    );
    if (res.ok) return ctx;
    if (res.status !== 404) {
      lastError = new GmailResolutionError(
        "GMAIL_API_ERROR",
        `Gmail API error ${res.status} while probing integration ${doc.id}`,
        500
      );
    }
  }

  throw (
    lastError ||
    new GmailResolutionError(
      "MESSAGE_NOT_FOUND",
      "Message not found in any of the user's Gmail accounts.",
      404
    )
  );
}

/**
 * Convenience: resolve integration either by explicit id or by probing.
 */
export async function resolveGmailIntegration(
  args: { integrationId?: string | null; messageId: string },
  userId: string
): Promise<GmailIntegrationContext> {
  if (args.integrationId) {
    return resolveIntegrationById(args.integrationId, userId);
  }
  return resolveIntegrationByMessageId(args.messageId, userId);
}
