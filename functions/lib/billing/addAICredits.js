"use strict";
/**
 * Create a Stripe Checkout session for one-time AI credit purchase.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.addAICreditsCallable = void 0;
const stripe_1 = __importDefault(require("stripe"));
const params_1 = require("firebase-functions/params");
const createCallable_1 = require("../utils/createCallable");
const config_1 = require("./config");
const stripeSecretKey = (0, params_1.defineSecret)("STRIPE_SECRET_KEY");
exports.addAICreditsCallable = (0, createCallable_1.createCallable)({
    name: "addAICredits",
    secrets: [stripeSecretKey],
}, async (ctx, request) => {
    const { amountEur, successUrl, cancelUrl } = request;
    if (!amountEur || amountEur < 1 || amountEur > 100) {
        throw new createCallable_1.HttpsError("invalid-argument", "Amount must be between 1 and 100 EUR");
    }
    if (!successUrl || !cancelUrl) {
        throw new createCallable_1.HttpsError("invalid-argument", "successUrl and cancelUrl are required");
    }
    const stripe = new stripe_1.default(stripeSecretKey.value());
    // Get or create Stripe customer
    const subDoc = await ctx.db.collection("subscriptions").doc(ctx.userId).get();
    let stripeCustomerId = subDoc.data()?.stripeCustomerId;
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
    const products = (0, config_1.getStripeProducts)(stripeSecretKey.value());
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
        throw new createCallable_1.HttpsError("internal", "Failed to create checkout session");
    }
    return { checkoutUrl: session.url };
});
//# sourceMappingURL=addAICredits.js.map