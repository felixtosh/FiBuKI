/**
 * Create a Stripe Checkout session for a €10 country backing payment.
 * Does NOT require authentication — public marketing page.
 */

import Stripe from "stripe";
import { defineSecret } from "firebase-functions/params";
import { createCallable, HttpsError } from "../utils/createCallable";

const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");

interface BackCountryRequest {
  countryCode: string;
  email: string;
  successUrl: string;
  cancelUrl: string;
}

interface BackCountryResponse {
  checkoutUrl: string;
}

/** Backing amount: €10 in cents */
const BACKING_AMOUNT_CENTS = 1000;

export const backCountryCallable = createCallable<
  BackCountryRequest,
  BackCountryResponse
>(
  {
    name: "backCountry",
    secrets: [stripeSecretKey],
    allowUnauthenticated: true,
  },
  async (ctx, request) => {
    const { countryCode, email, successUrl, cancelUrl } = request;

    if (!countryCode || !email || !successUrl || !cancelUrl) {
      throw new HttpsError("invalid-argument", "Missing required fields");
    }

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new HttpsError("invalid-argument", "Invalid email address");
    }

    // Verify country exists and is in "funding" status
    const countryDoc = await ctx.db
      .collection("countryExpansion")
      .doc(countryCode)
      .get();

    if (!countryDoc.exists) {
      throw new HttpsError("not-found", `Country ${countryCode} not found`);
    }

    const countryData = countryDoc.data()!;
    if (countryData.status !== "funding") {
      throw new HttpsError(
        "failed-precondition",
        countryData.status === "active"
          ? "This country is already live!"
          : "This country is not yet open for backing"
      );
    }

    // Check if this email already backed this country
    const existingBacker = await ctx.db
      .collection("countryBackers")
      .where("countryCode", "==", countryCode)
      .where("email", "==", email)
      .where("status", "==", "paid")
      .limit(1)
      .get();

    if (!existingBacker.empty) {
      throw new HttpsError(
        "already-exists",
        "You have already backed this country"
      );
    }

    const stripe = new Stripe(stripeSecretKey.value());

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: {
              name: `Back FiBuKI in ${countryData.countryName}`,
              description: `€10 commitment to help bring FiBuKI to ${countryData.countryName}. Applied as credit toward your first month.`,
            },
            unit_amount: BACKING_AMOUNT_CENTS,
          },
          quantity: 1,
        },
      ],
      metadata: {
        type: "country_backing",
        countryCode,
        email,
        userId: ctx.userId !== "anonymous" ? ctx.userId : "",
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    if (!session.url) {
      throw new HttpsError("internal", "Failed to create checkout session");
    }

    return { checkoutUrl: session.url };
  }
);
