/**
 * Create a Stripe Checkout session for one-time AI credit purchase.
 */

import Stripe from "stripe";
import { defineSecret } from "firebase-functions/params";
import { createCallable, HttpsError } from "../utils/createCallable";
import { getStripeProducts } from "./config";

const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");

interface AddAICreditsRequest {
  amountEur: number;
  successUrl: string;
  cancelUrl: string;
}

interface AddAICreditsResponse {
  checkoutUrl: string;
}

export const addAICreditsCallable = createCallable<
  AddAICreditsRequest,
  AddAICreditsResponse
>(
  {
    name: "addAICredits",
    secrets: [stripeSecretKey],
  },
  async (ctx, request) => {
    const { amountEur, successUrl, cancelUrl } = request;

    if (!amountEur || amountEur < 1 || amountEur > 100) {
      throw new HttpsError("invalid-argument", "Amount must be between 1 and 100 EUR");
    }

    if (!successUrl || !cancelUrl) {
      throw new HttpsError("invalid-argument", "successUrl and cancelUrl are required");
    }

    const stripe = new Stripe(stripeSecretKey.value());

    // Get or create Stripe customer
    const subDoc = await ctx.db.collection("subscriptions").doc(ctx.userId).get();
    let stripeCustomerId = subDoc.data()?.stripeCustomerId as string | null;

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        metadata: { firebaseUserId: ctx.userId },
      });
      stripeCustomerId = customer.id;
      await ctx.db.collection("subscriptions").doc(ctx.userId).update({
        stripeCustomerId,
        updatedAt: new Date(),
      });
    }

    // Create checkout session for one-time payment (use synced product)
    const products = getStripeProducts(stripeSecretKey.value());
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "eur",
            unit_amount: Math.round(amountEur * 100), // cents
            ...(products.aiCredits
              ? { product: products.aiCredits }
              : {
                  product_data: {
                    name: `AI Credits (${amountEur.toFixed(2)} EUR)`,
                    description: "Prepaid AI credits for FiBuKI auto-matching",
                  },
                }),
          },
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        userId: ctx.userId,
        type: "ai_credits",
        amountEur: amountEur.toString(),
      },
    });

    if (!session.url) {
      throw new HttpsError("internal", "Failed to create checkout session");
    }

    return { checkoutUrl: session.url };
  }
);
