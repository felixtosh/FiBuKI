/**
 * Create a Stripe Checkout session for plan subscription.
 */

import Stripe from "stripe";
import { defineSecret } from "firebase-functions/params";
import { createCallable, HttpsError } from "../utils/createCallable";
import { getStripePrices, PLANS, createDefaultSubscriptionData } from "./config";
import type { PlanId, BillingPeriod } from "./config";

const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");

interface CreateCheckoutSessionRequest {
  plan: PlanId;
  billingPeriod: BillingPeriod;
  successUrl: string;
  cancelUrl: string;
}

interface CreateCheckoutSessionResponse {
  checkoutUrl: string;
}

export const createCheckoutSessionCallable = createCallable<
  CreateCheckoutSessionRequest,
  CreateCheckoutSessionResponse
>(
  {
    name: "createCheckoutSession",
    secrets: [stripeSecretKey],
  },
  async (ctx, request) => {
    const { plan, billingPeriod, successUrl, cancelUrl } = request;

    if (!plan || !billingPeriod || !successUrl || !cancelUrl) {
      throw new HttpsError("invalid-argument", "Missing required fields");
    }

    if (plan === "free") {
      throw new HttpsError("invalid-argument", "Cannot checkout for free plan");
    }

    if (!PLANS[plan]) {
      throw new HttpsError("invalid-argument", `Invalid plan: ${plan}`);
    }

    const stripe = new Stripe(stripeSecretKey.value());
    const prices = getStripePrices(stripeSecretKey.value());
    const priceId = prices[plan]?.[billingPeriod];
    if (!priceId) {
      throw new HttpsError("invalid-argument", `No price configured for ${plan}/${billingPeriod}`);
    }

    // Check if user already has a Stripe customer
    const subDoc = await ctx.db.collection("subscriptions").doc(ctx.userId).get();
    let stripeCustomerId = subDoc.data()?.stripeCustomerId as string | null;

    // Create Stripe customer if needed
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        metadata: { firebaseUserId: ctx.userId },
      });
      stripeCustomerId = customer.id;

      // Ensure subscription doc exists
      if (!subDoc.exists) {
        await ctx.db.collection("subscriptions").doc(ctx.userId).set({
          ...createDefaultSubscriptionData(ctx.userId),
          stripeCustomerId,
        });
      } else {
        await ctx.db.collection("subscriptions").doc(ctx.userId).update({
          stripeCustomerId,
          updatedAt: new Date(),
        });
      }
    }

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        userId: ctx.userId,
        plan,
        billingPeriod,
      },
      subscription_data: {
        metadata: {
          userId: ctx.userId,
          plan,
          billingPeriod,
        },
      },
    });

    if (!session.url) {
      throw new HttpsError("internal", "Failed to create checkout session");
    }

    return { checkoutUrl: session.url };
  }
);
