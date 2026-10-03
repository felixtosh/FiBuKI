/**
 * The correction-link acts behind the UI (#564): link (also how a suggestion
 * is accepted), unlink or decline, inspect, and the one-time pass over
 * existing credit notes. Each checks that the user owns every id it is given;
 * the state transitions live in correctionOps, shared with the MCP tools.
 */

import { createCallable } from "../utils/createCallable";
import {
  backfillCorrectionLinks,
  getCorrection,
  linkCorrection,
  unlinkCorrection,
  type BackfillCorrectionLinksResult,
  type CorrectionFileView,
  type CorrectionTransactionView,
  type LinkCorrectionResult,
  type UnlinkCorrectionResult,
} from "./correctionOps";

export const linkCorrectionCallable = createCallable<
  { fileId: string; originalFileId: string },
  LinkCorrectionResult
>({ name: "linkCorrection" }, async (ctx, request) =>
  linkCorrection(ctx.db, ctx.userId, (request ?? {}) as Record<string, unknown>)
);

export const unlinkCorrectionCallable = createCallable<
  { fileId: string; originalFileId?: string },
  UnlinkCorrectionResult
>({ name: "unlinkCorrection" }, async (ctx, request) =>
  unlinkCorrection(ctx.db, ctx.userId, (request ?? {}) as Record<string, unknown>)
);

export const getCorrectionCallable = createCallable<
  { fileId?: string; transactionId?: string },
  CorrectionFileView | CorrectionTransactionView
>({ name: "getCorrection" }, async (ctx, request) =>
  getCorrection(ctx.db, ctx.userId, (request ?? {}) as Record<string, unknown>)
);

export const backfillCorrectionLinksCallable = createCallable<
  Record<string, never>,
  BackfillCorrectionLinksResult
>({ name: "backfillCorrectionLinks", timeoutSeconds: 300 }, async (ctx) =>
  backfillCorrectionLinks(ctx.db, ctx.userId)
);
