/**
 * Accepted Partial Payment (#554): record - or revoke - the ruling that a
 * tipped Transaction's bank line really is short of `document + tip` (a split
 * bill, an instalment), so the UVA claims it in part and the BMD export books
 * it instead of refusing it.
 *
 * The rules live in `partialPaymentRulingOps`, shared with the
 * `accept_partial_payment` MCP tool.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import { PartialPaymentRulingError, rulePartialPayment } from "./partialPaymentRulingOps";

interface AcceptPartialPaymentRequest {
  /** Transaction ID to rule on */
  id: string;
  action: "accept" | "revoke";
  /** accept only: why the shortfall is real. Required - the reason IS the record. */
  reason?: string;
}

interface AcceptPartialPaymentResponse {
  success: boolean;
}

export const acceptPartialPaymentCallable = createCallable<
  AcceptPartialPaymentRequest,
  AcceptPartialPaymentResponse
>(
  { name: "acceptPartialPayment" },
  async (ctx, request) => {
    try {
      await rulePartialPayment(ctx.db, ctx.userId, {
        transactionId: request.id,
        action: request.action,
        reason: request.reason,
      });
    } catch (error) {
      if (error instanceof PartialPaymentRulingError) {
        throw new HttpsError(error.code, error.message);
      }
      throw error;
    }
    return { success: true };
  }
);
