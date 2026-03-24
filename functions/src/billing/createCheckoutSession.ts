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

    const stripeKey = stripeSecretKey.value().trim();
    const stripe = new Stripe(stripeKey);
    const prices = getStripePrices(stripeKey);
    const priceId = prices[plan]?.[billingPeriod];
    if (!priceId) {
      throw new HttpsError("invalid-argument", `No price configured for ${plan}/${billingPeriod}`);
    }

    // Check if user already has a Stripe customer
    const subDoc = await ctx.db.collection("subscriptions").doc(ctx.userId).get();
    let stripeCustomerId = subDoc.data()?.stripeCustomerId as string | null;

    // Create Stripe customer if needed
    const userEmail = ctx.request.auth?.token?.email || undefined;

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        ...(userEmail ? { email: userEmail } : {}),
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

    // Check for referral discount (yearly plans only)
    const discounts: Array<{ promotion_code: string }> = [];
    if (billingPeriod === "yearly") {
      const pendingConversion = await ctx.db
        .collection("referralConversions")
        .where("referredUserId", "==", ctx.userId)
        .where("status", "==", "pending")
        .limit(1)
        .get();

      if (!pendingConversion.empty) {
        const conversion = pendingConversion.docs[0].data();
        if (conversion.stripePromotionCodeId) {
          discounts.push({ promotion_code: conversion.stripePromotionCodeId });
        } else {
          // Create a Stripe promotion code for this referral
          try {
            // Find or create the referral coupon
            let couponId = "referral_20_off_yearly";
            try {
              await stripe.coupons.retrieve(couponId);
            } catch {
              // Create coupon if it doesn't exist
              await stripe.coupons.create({
                id: couponId,
                amount_off: 2000,
                currency: "eur",
                duration: "once",
                name: "Referral: €20 off first year",
              });
            }

            const promoCode = await stripe.promotionCodes.create({
              promotion: { type: "coupon", coupon: couponId },
              max_redemptions: 1,
              metadata: {
                referralCode: conversion.referralCode,
                referredUserId: ctx.userId,
              },
            });

            // Store promotion code ID on conversion
            await pendingConversion.docs[0].ref.update({
              stripePromotionCodeId: promoCode.id,
            });

            discounts.push({ promotion_code: promoCode.id });
          } catch (err) {
            console.error("[createCheckoutSession] Failed to create referral promo code:", err);
            // Continue without discount — don't block checkout
          }
        }
      }
    }

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      ...(discounts.length > 0 ? { discounts } : {}),
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
