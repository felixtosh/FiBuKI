/**
 * Record first-touch signup attribution for the authenticated user (GTM Phase 1).
 *
 * Called once post-signup by the auth pages, the same way they call
 * `applyReferralCode`. Writes `signupAttribution/{uid}` with the UTM parameters,
 * referrer and landing path the client captured on first touch.
 *
 * First-touch: an existing document is never overwritten, so a later visit on a
 * different campaign cannot rewrite how the account was originally acquired.
 */

import { FieldValue } from "firebase-admin/firestore";
import { createCallable } from "../utils/createCallable";

interface AttributionInput {
  utmSource?: unknown;
  utmMedium?: unknown;
  utmCampaign?: unknown;
  utmTerm?: unknown;
  utmContent?: unknown;
  referrer?: unknown;
  landingPath?: unknown;
}

interface RecordSignupAttributionRequest {
  attribution?: AttributionInput;
}

interface RecordSignupAttributionResponse {
  /** true if this call wrote the first-touch record, false if one already existed. */
  recorded: boolean;
}

// The payload is untrusted client input: coerce each field to a trimmed string
// or null and cap its length so a crafted request cannot bloat the document.
const MAX_FIELD_LENGTH = 1024;

function cleanField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_FIELD_LENGTH);
}

export const recordSignupAttributionCallable = createCallable<
  RecordSignupAttributionRequest,
  RecordSignupAttributionResponse
>(
  { name: "recordSignupAttribution" },
  async (ctx, request) => {
    const input = request.attribution || {};

    const data = {
      uid: ctx.userId,
      utmSource: cleanField(input.utmSource),
      utmMedium: cleanField(input.utmMedium),
      utmCampaign: cleanField(input.utmCampaign),
      utmTerm: cleanField(input.utmTerm),
      utmContent: cleanField(input.utmContent),
      referrer: cleanField(input.referrer),
      landingPath: cleanField(input.landingPath),
      createdAt: FieldValue.serverTimestamp(),
    };

    const ref = ctx.db.collection("signupAttribution").doc(ctx.userId);

    // First-touch via a transaction: keep the original record if one already
    // exists. runTransaction is optimistic (the callback may re-run), so it
    // reads before it writes and holds no side effects.
    const recorded = await ctx.db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      if (existing.exists) return false;
      tx.set(ref, data);
      return true;
    });

    return { recorded };
  }
);
