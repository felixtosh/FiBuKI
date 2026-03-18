/**
 * Get or create a referral code for the authenticated user.
 */

import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { createCallable } from "../utils/createCallable";

interface GetReferralCodeResponse {
  code: string;
  shareUrl: string;
}

function generateCode(displayName: string | undefined): string {
  const prefix = (displayName || "")
    .replace(/[^a-zA-Z]/g, "")
    .toUpperCase()
    .slice(0, 4);
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix || "REF"}${random}`.slice(0, 8);
}

export const getReferralCodeCallable = createCallable<
  void,
  GetReferralCodeResponse
>(
  { name: "getReferralCode" },
  async (ctx) => {
    // Check if user already has a referral code
    const existing = await ctx.db
      .collection("referrals")
      .where("userId", "==", ctx.userId)
      .limit(1)
      .get();

    if (!existing.empty) {
      const doc = existing.docs[0];
      const code = doc.id;
      return { code, shareUrl: `https://fibuki.com/r/${code}` };
    }

    // Get user display name for code prefix
    const user = await getAuth().getUser(ctx.userId);
    let code = generateCode(user.displayName || undefined);

    // Ensure code is unique (retry if collision)
    let attempts = 0;
    while (attempts < 5) {
      const existing = await ctx.db.collection("referrals").doc(code).get();
      if (!existing.exists) break;
      code = generateCode(user.displayName || undefined);
      attempts++;
    }

    // Create referral doc (doc ID = code for fast lookups)
    await ctx.db.collection("referrals").doc(code).set({
      code,
      userId: ctx.userId,
      createdAt: FieldValue.serverTimestamp(),
    });

    return { code, shareUrl: `https://fibuki.com/r/${code}` };
  }
);
