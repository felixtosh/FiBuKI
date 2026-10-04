/**
 * Connect a File to a Transaction from a Next API route, as the user who
 * called the route: through the connect callable, so the File Connection
 * writer (#612) checks ownership and applies the rules a connect in the app
 * follows. A route never writes the three records itself.
 */

import { callFirebaseFunction } from "@/lib/api/firebase-callable";

export interface RouteConnectRequest {
  fileId: string;
  transactionId: string;
  /** How the File arrived; a manual connect's stored label. */
  connectionType?: "manual" | "gmail_import" | "gmail_html_conversion";
  sourceInfo?: {
    sourceType?: string;
    searchPattern?: string;
    gmailIntegrationId?: string;
    gmailIntegrationEmail?: string;
    mailMessageId?: string;
    gmailMessageFrom?: string;
    gmailMessageFromName?: string;
    resultType?: string;
  };
}

/**
 * Returns null when connected (or already connected), otherwise why not. A
 * route without the user's bearer token cannot connect: the internal service
 * secret is no user session.
 */
export async function connectFileAsUser(
  request: Request,
  connect: RouteConnectRequest
): Promise<string | null> {
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) {
    return "Connecting needs the user's session";
  }
  try {
    await callFirebaseFunction(
      "connectFileToTransaction",
      { ...connect, origin: "manual" },
      authorization
    );
    return null;
  } catch (err) {
    return refusalMessage(err);
  }
}

/** The callable's own message out of the helper's "failed: <status> - <body>" error. */
function refusalMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : "";
  const body = text.slice(text.indexOf(" - ") + 3);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") return parsed.error.message;
  } catch {
    // not the callable's JSON: fall through
  }
  return text || "Connecting the File failed";
}
