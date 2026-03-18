/**
 * Validate and store a referral code during registration.
 * Called after registration, before first checkout.
 */

import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";

interface ApplyReferralCodeRequest {
  code: string;
}

interface ApplyReferralCodeResponse {
  valid: boolean;
  referrerName?: string;
}

export const applyReferralCodeCallable = createCallable<
  ApplyReferralCodeRequest,
  ApplyReferralCodeResponse
>(
  { name: "applyReferralCode" },
  async (ctx, request) => {
    const { code } = request;

    if (!code) {
      throw new HttpsError("invalid-argument", "Referral code is required");
    }

    const normalizedCode = code.toUpperCase().trim();

    // Look up the referral code
    const referralDoc = await ctx.db.collection("referrals").doc(normalizedCode).get();
    if (!referralDoc.exists) {
      return { valid: false };
    }

    const referral = referralDoc.data()!;

    // Can't refer yourself
    if (referral.userId === ctx.userId) {
      return { valid: false };
    }

    // Check if user already has a conversion (no double-dipping)
    const existingConversion = await ctx.db
      .collection("referralConversions")
      .where("referredUserId", "==", ctx.userId)
      .limit(1)
      .get();

    if (!existingConversion.empty) {
      return { valid: false };
    }

    // Get referrer display name
    let referrerName: string | undefined;
    try {
      const referrer = await getAuth().getUser(referral.userId);
      referrerName = referrer.displayName || undefined;
    } catch {
      // Referrer account may be deleted
    }

    // Get referred user's email
    const referredUser = await getAuth().getUser(ctx.userId);
    const referredEmail = referredUser.email || "";

    // Create referral conversion doc
    await ctx.db.collection("referralConversions").add({
      referralCode: normalizedCode,
      referrerUserId: referral.userId,
      referredUserId: ctx.userId,
      referredEmail,
      status: "pending",
      referrerCreditApplied: false,
      createdAt: FieldValue.serverTimestamp(),
    });

    // Store referredBy on subscription doc (create if needed)
    const subRef = ctx.db.collection("subscriptions").doc(ctx.userId);
    const subDoc = await subRef.get();
    if (subDoc.exists) {
      await subRef.update({
        referredBy: normalizedCode,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      // Will be created properly later, just store the referral
      await subRef.set(
        { referredBy: normalizedCode, updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
    }

    return { valid: true, referrerName };
  }
);
