/**
 * Switch between billing plans via Stripe API.
 *
 * - Paid→Paid: Updates the existing subscription's price (with proration)
 * - Paid→Free: Cancels the subscription immediately
 *
 * For Free→Paid (no existing subscription), the frontend should use
 * createCheckoutSession instead, since payment info is needed.
 */

import Stripe from "stripe";
import { defineSecret } from "firebase-functions/params";
import { createCallable, HttpsError } from "../utils/createCallable";
import { getStripePrices, PLANS } from "./config";
import type { PlanId } from "./config";

const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");

interface SwitchPlanRequest {
  plan: PlanId;
}

interface SwitchPlanResponse {
  success: boolean;
}

export const switchPlanCallable = createCallable<
  SwitchPlanRequest,
  SwitchPlanResponse
>(
  {
    name: "switchPlan",
    secrets: [stripeSecretKey],
  },
  async (ctx, request) => {
    const { plan } = request;

    if (!plan) {
      throw new HttpsError("invalid-argument", "plan is required");
    }

    if (!PLANS[plan]) {
      throw new HttpsError("invalid-argument", `Invalid plan: ${plan}`);
    }

    // Get user's current subscription
    const subDoc = await ctx.db.collection("subscriptions").doc(ctx.userId).get();
    if (!subDoc.exists) {
      throw new HttpsError("not-found", "No subscription found");
    }

    const subData = subDoc.data()!;
    const stripeSubscriptionId = subData.stripeSubscriptionId as string | null;

    if (!stripeSubscriptionId) {
      throw new HttpsError(
        "failed-precondition",
        "No active Stripe subscription. Use checkout to subscribe first."
      );
    }

    const stripeKey = stripeSecretKey.value().trim();
    const stripe = new Stripe(stripeKey);

    if (plan === "free") {
      // Cancel subscription immediately
      await stripe.subscriptions.cancel(stripeSubscriptionId);
      // Webhook (customer.subscription.deleted) will update Firestore
      return { success: true };
    }

    // Switch to a different paid plan
    const currentBillingPeriod = (subData.billingPeriod || "monthly") as "monthly" | "yearly";
    const prices = getStripePrices(stripeKey);
    const newPriceId = prices[plan]?.[currentBillingPeriod];

    if (!newPriceId) {
      throw new HttpsError(
        "failed-precondition",
        `No price configured for ${plan}/${currentBillingPeriod}`
      );
    }

    // Get current subscription to find the subscription item ID
    const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    const itemId = subscription.items.data[0]?.id;

    if (!itemId) {
      throw new HttpsError("internal", "Could not find subscription item");
    }

    // Update the subscription with the new price
    await stripe.subscriptions.update(stripeSubscriptionId, {
      items: [{ id: itemId, price: newPriceId }],
      metadata: { ...subscription.metadata, plan },
      proration_behavior: "create_prorations",
    });

    // Webhook (customer.subscription.updated) will update Firestore
    return { success: true };
  }
);
