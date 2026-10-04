/**
 * The Receipt Link acts behind the UI (#571, ADR-0012): link (also how a
 * suggestion is accepted), unlink or decline, inspect, and the one-time
 * suggestion pass over stored Files. Each checks that the user owns every id
 * it is given; the state transitions live in receiptPairOps, shared with the
 * MCP tools and the chat assistant.
 */

import { createCallable } from "../utils/createCallable";
import {
  backfillReceiptPairs,
  getReceiptLink,
  linkReceipt,
  unlinkReceipt,
  type BackfillReceiptPairsResult,
  type LinkReceiptResult,
  type ReceiptLinkView,
  type UnlinkReceiptResult,
} from "./receiptPairOps";

export const linkReceiptCallable = createCallable<
  { fileId: string; invoiceFileId: string },
  LinkReceiptResult
>({ name: "linkReceipt" }, async (ctx, request) =>
  linkReceipt(ctx.db, ctx.userId, (request ?? {}) as Record<string, unknown>)
);

export const unlinkReceiptCallable = createCallable<
  { fileId: string; otherFileId?: string },
  UnlinkReceiptResult
>({ name: "unlinkReceipt" }, async (ctx, request) =>
  unlinkReceipt(ctx.db, ctx.userId, (request ?? {}) as Record<string, unknown>)
);

export const getReceiptLinkCallable = createCallable<{ fileId: string }, ReceiptLinkView>(
  { name: "getReceiptLink" },
  async (ctx, request) => getReceiptLink(ctx.db, ctx.userId, (request ?? {}) as Record<string, unknown>)
);

export const backfillReceiptPairsCallable = createCallable<Record<string, never>, BackfillReceiptPairsResult>(
  { name: "backfillReceiptPairs", timeoutSeconds: 300 },
  async (ctx) => backfillReceiptPairs(ctx.db, ctx.userId)
);
