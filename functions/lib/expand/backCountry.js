"use strict";
/**
 * Create a Stripe Checkout session for a €10 country backing payment.
 * Does NOT require authentication — public marketing page.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.backCountryCallable = void 0;
const stripe_1 = __importDefault(require("stripe"));
const params_1 = require("firebase-functions/params");
const createCallable_1 = require("../utils/createCallable");
const stripeSecretKey = (0, params_1.defineSecret)("STRIPE_SECRET_KEY");
/** Backing amount: €10 in cents */
const BACKING_AMOUNT_CENTS = 1000;
exports.backCountryCallable = (0, createCallable_1.createCallable)({
    name: "backCountry",
    secrets: [stripeSecretKey],
    allowUnauthenticated: true,
}, async (ctx, request) => {
    const { countryCode, email, successUrl, cancelUrl } = request;
    if (!countryCode || !email || !successUrl || !cancelUrl) {
        throw new createCallable_1.HttpsError("invalid-argument", "Missing required fields");
    }
    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new createCallable_1.HttpsError("invalid-argument", "Invalid email address");
    }
    // Verify country exists and is in "funding" status
    const countryDoc = await ctx.db
        .collection("countryExpansion")
        .doc(countryCode)
        .get();
    if (!countryDoc.exists) {
        throw new createCallable_1.HttpsError("not-found", `Country ${countryCode} not found`);
    }
    const countryData = countryDoc.data();
    if (countryData.status !== "funding") {
        throw new createCallable_1.HttpsError("failed-precondition", countryData.status === "active"
            ? "This country is already live!"
            : "This country is not yet open for backing");
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
        throw new createCallable_1.HttpsError("already-exists", "You have already backed this country");
    }
    const stripe = new stripe_1.default(stripeSecretKey.value());
    const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: email,
        line_items: [
            {
                price_data: {
                    currency: "eur",
                    product_data: {
                        name: `Unlock PSD2 banking in ${countryData.countryName}`,
                        description: `€10 commitment to help activate PSD2 bank connections in ${countryData.countryName}. Covers your entire first month.`,
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
        throw new createCallable_1.HttpsError("internal", "Failed to create checkout session");
    }
    return { checkoutUrl: session.url };
});
//# sourceMappingURL=backCountry.js.map