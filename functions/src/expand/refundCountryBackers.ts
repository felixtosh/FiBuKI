/**
 * Admin-only: Bulk refund all backers for a country that didn't reach its goal.
 */

import Stripe from "stripe";
import { defineSecret } from "firebase-functions/params";
import { createCallable, HttpsError } from "../utils/createCallable";
import { FieldValue } from "firebase-admin/firestore";

const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");

interface RefundCountryBackersRequest {
  countryCode: string;
}

interface RefundCountryBackersResponse {
  success: boolean;
  refundedCount: number;
}

export const refundCountryBackersCallable = createCallable<
  RefundCountryBackersRequest,
  RefundCountryBackersResponse
>(
  {
    name: "refundCountryBackers",
    secrets: [stripeSecretKey],
    timeoutSeconds: 300, // Bulk refunds may take a while
  },
  async (ctx, request) => {
    const { countryCode } = request;

    if (!countryCode) {
      throw new HttpsError("invalid-argument", "countryCode is required");
    }

    // Admin check
    const isAdmin = ctx.request.auth?.token?.admin === true;
    const isSuperAdmin = ctx.request.auth?.token?.email === process.env.SUPER_ADMIN_EMAIL;
    if (!isAdmin && !isSuperAdmin) {
      throw new HttpsError("permission-denied", "Admin access required");
    }

    const countryRef = ctx.db.collection("countryExpansion").doc(countryCode);
    const countryDoc = await countryRef.get();

    if (!countryDoc.exists) {
      throw new HttpsError("not-found", `Country ${countryCode} not found`);
    }

    // Get all paid backers
    const backersSnap = await ctx.db
      .collection("countryBackers")
      .where("countryCode", "==", countryCode)
      .where("status", "==", "paid")
      .get();

    if (backersSnap.empty) {
      return { success: true, refundedCount: 0 };
    }

    const stripe = new Stripe(stripeSecretKey.value().trim());
    let refundedCount = 0;

    for (const backerDoc of backersSnap.docs) {
      const backer = backerDoc.data();
      try {
        await stripe.refunds.create({
          payment_intent: backer.stripePaymentIntentId,
        });

        await backerDoc.ref.update({
          status: "refunded",
          refundedAt: FieldValue.serverTimestamp(),
        });

        refundedCount++;
      } catch (err) {
        console.error(
          `[refundCountryBackers] Failed to refund ${backerDoc.id}:`,
          err
        );
        // Continue with other refunds
      }
    }

    // Update country counters
    await countryRef.update({
      currentBackers: 0,
      totalCommitted: 0,
      status: "coming_soon",
    });

    console.log(
      `[refundCountryBackers] ${countryCode}: ${refundedCount}/${backersSnap.size} refunded`
    );

    return { success: true, refundedCount };
  }
);
