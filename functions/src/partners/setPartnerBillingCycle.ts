/**
 * Declare, change or clear the declared half of a partner's billing cycle
 * from the UI (#170).
 *
 * The whole body of this callable is a delegation: `set_partner_billing_cycle`
 * (#167) already owns parsing a declaration, refusing an ambiguous one and
 * re-resolving the effective view through `resolveEffectiveCycles`. The partner
 * panel writes through the same path rather than a second one, so a cycle
 * declared by hand and one declared by a script cannot end up shaped
 * differently.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import type { DeclaredCycleInput } from "../matching/billingCycle";

/** One declared recurrence as the tool takes it: a named cadence or raw days. */
export interface DeclaredCycleRequest extends Partial<DeclaredCycleInput> {
  cadence?: string;
  currency?: string;
}

interface SetPartnerBillingCycleRequest {
  partnerId: string;
  /** One recurrence, one per amount band, or null to drop every declaration. */
  declared: DeclaredCycleRequest | DeclaredCycleRequest[] | null;
}

interface SetPartnerBillingCycleResponse {
  success: boolean;
  partnerId: string;
  billingCycle: Record<string, unknown> | null;
}

export const setPartnerBillingCycleCallable = createCallable<
  SetPartnerBillingCycleRequest,
  SetPartnerBillingCycleResponse
>(
  { name: "setPartnerBillingCycle" },
  async (ctx, request) => {
    if (!request?.partnerId) {
      throw new HttpsError("invalid-argument", "partnerId is required");
    }
    // `declared: null` clears, so the key has to be present to mean anything —
    // an absent one is a malformed request, not "leave it alone".
    if (!("declared" in request)) {
      throw new HttpsError(
        "invalid-argument",
        "declared is required (pass null to clear the declared cycle)"
      );
    }

    // Imported lazily, the way the tool registry pulls in a callable's
    // internals: `handlers.ts` takes a Firestore handle at module scope, and
    // this module is loaded from the functions index.
    const { setPartnerBillingCycle } = await import("../tools/handlers");

    try {
      const result = await setPartnerBillingCycle(ctx.userId, {
        partnerId: request.partnerId,
        declared: request.declared,
      });
      return result as SetPartnerBillingCycleResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The handler throws plain Errors: a missing partner is the caller's
      // ownership problem, everything else is a rejected declaration.
      throw new HttpsError(
        message === "Partner not found" ? "not-found" : "invalid-argument",
        message
      );
    }
  }
);
