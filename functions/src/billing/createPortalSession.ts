/**
 * Create a Stripe Customer Portal session for managing subscriptions.
 */

import Stripe from "stripe";
import { defineSecret } from "firebase-functions/params";
import { createCallable, HttpsError } from "../utils/createCallable";

const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");

interface CreatePortalSessionRequest {
  returnUrl: string;
}

interface CreatePortalSessionResponse {
  portalUrl: string;
}

export const createPortalSessionCallable = createCallable<
  CreatePortalSessionRequest,
  CreatePortalSessionResponse
>(
  {
    name: "createPortalSession",
    secrets: [stripeSecretKey],
  },
  async (ctx, request) => {
    const { returnUrl } = request;

    if (!returnUrl) {
      throw new HttpsError("invalid-argument", "returnUrl is required");
    }

    const subDoc = await ctx.db.collection("subscriptions").doc(ctx.userId).get();
    const stripeCustomerId = subDoc.data()?.stripeCustomerId as string | null;

    if (!stripeCustomerId) {
      throw new HttpsError(
        "failed-precondition",
        "No Stripe customer found. Please subscribe to a plan first."
      );
    }

    const stripe = new Stripe(stripeSecretKey.value().trim());

    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: returnUrl,
    });

    return { portalUrl: session.url };
  }
);
