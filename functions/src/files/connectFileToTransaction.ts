/**
 * Connect a file to a transaction (many-to-many relationship).
 *
 * The callable surface of the File Connection writer (#612): the rules a
 * connect follows key on its Connection Origin and live in
 * fileConnections/rules.ts.
 */

import { createCallable, HttpsError, type HandlerContext } from "../utils/createCallable";
import { connectFile, type ConnectPair, type FileConnectionSourceInfo } from "../fileConnections/writer";
import { isConnectionOrigin, type ConnectionOrigin } from "../fileConnections/rules";

/** The origins a caller of the callable may claim; the tool surface and the matcher are server-side. */
const CALLABLE_ORIGINS: ReadonlySet<ConnectionOrigin> = new Set(["manual", "suggestion", "agent", "auto"]);

export interface ConnectFileRequest {
  fileId: string;
  transactionId: string;
  /**
   * Who is connecting. Absent: `manual`, or `auto` for a request labelled
   * `auto_matched` (callers from before #612).
   */
  origin?: ConnectionOrigin;
  /** The stored label; only the labels the origin allows (rules.ts). */
  connectionType?: string;
  /** Ignored for an accepted suggestion: the server reads the stored one. */
  matchConfidence?: number | null;
  sourceInfo?: FileConnectionSourceInfo;
  /** The agent only: a human asked for this rejected pair. Lifts the Rejection. */
  overrideRejection?: boolean;
  /**
   * If true, this call may reassign existing auto/AI connections for the same
   * file or transaction. Manual/user-confirmed connections are never overridden.
   */
  allowAutoReassign?: boolean;
}

interface ConnectFileResponse {
  success: boolean;
  connectionId: string;
  alreadyConnected: boolean;
  reassignedConnections?: number;
}

export const connectFileToTransactionCallable = createCallable<
  ConnectFileRequest,
  ConnectFileResponse
>({ name: "connectFileToTransaction" }, (ctx, request) =>
  performConnectFileToTransaction(ctx, request ?? ({} as ConnectFileRequest))
);

/**
 * What only server code may add to a connect, beside the request. The
 * callable passes none, so no client can set it.
 */
export interface ServerConnectFields {
  /**
   * Why an automated connect was allowed outside the full-amount case: the
   * find-receipt workflow's instalment (#716, ADR-0013). Stored only on an
   * `auto` connect.
   */
  autoConnectReason?: ConnectPair["autoConnectReason"];
}

/**
 * The connect itself, for a caller that already holds the user: the
 * find-receipt workflow's auto-connect (#588) and the Split's parts.
 */
export async function performConnectFileToTransaction(
  ctx: Pick<HandlerContext, "db" | "userId">,
  request: ConnectFileRequest,
  server: ServerConnectFields = {}
): Promise<ConnectFileResponse> {
  const { fileId, transactionId } = request;
  if (typeof fileId !== "string" || !fileId || typeof transactionId !== "string" || !transactionId) {
    throw new HttpsError("invalid-argument", "fileId and transactionId are required");
  }

  let origin: ConnectionOrigin = request.connectionType === "auto_matched" ? "auto" : "manual";
  if (request.origin !== undefined) {
    if (!isConnectionOrigin(request.origin) || !CALLABLE_ORIGINS.has(request.origin)) {
      throw new HttpsError("invalid-argument", "origin must be manual, suggestion, agent or auto");
    }
    origin = request.origin;
  }

  const outcome = await connectFile(
    ctx.db,
    ctx.userId,
    {
      fileId,
      transactionId,
      matchConfidence: typeof request.matchConfidence === "number" ? request.matchConfidence : null,
      sourceInfo: request.sourceInfo,
      connectionType: typeof request.connectionType === "string" ? request.connectionType : undefined,
      ...(server.autoConnectReason && origin === "auto" ? { autoConnectReason: server.autoConnectReason } : {}),
    },
    {
      origin,
      overrideRejection: request.overrideRejection === true,
      replaceAutomated: request.allowAutoReassign === true,
    }
  );

  return {
    success: true,
    connectionId: outcome.connectionId,
    alreadyConnected: outcome.status === "already-connected",
    ...(outcome.status === "connected" ? { reassignedConnections: outcome.reassignedConnections } : {}),
  };
}
