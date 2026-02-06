"use strict";
/**
 * Create a Stripe Checkout session for plan subscription.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCheckoutSessionCallable = void 0;
const stripe_1 = __importDefault(require("stripe"));
const params_1 = require("firebase-functions/params");
const createCallable_1 = require("../utils/createCallable");
const config_1 = require("./config");
const stripeSecretKey = (0, params_1.defineSecret)("STRIPE_SECRET_KEY");
exports.createCheckoutSessionCallable = (0, createCallable_1.createCallable)({
    name: "createCheckoutSession",
    secrets: [stripeSecretKey],
}, async (ctx, request) => {
    const { plan, billingPeriod, successUrl, cancelUrl } = request;
    if (!plan || !billingPeriod || !successUrl || !cancelUrl) {
        throw new createCallable_1.HttpsError("invalid-argument", "Missing required fields");
    }
    if (plan === "free") {
        throw new createCallable_1.HttpsError("invalid-argument", "Cannot checkout for free plan");
    }
    if (!config_1.PLANS[plan]) {
        throw new createCallable_1.HttpsError("invalid-argument", `Invalid plan: ${plan}`);
    }
    const stripe = new stripe_1.default(stripeSecretKey.value());
    const prices = (0, config_1.getStripePrices)(stripeSecretKey.value());
    const priceId = prices[plan]?.[billingPeriod];
    if (!priceId) {
        throw new createCallable_1.HttpsError("invalid-argument", `No price configured for ${plan}/${billingPeriod}`);
    }
    // Check if user already has a Stripe customer
    const subDoc = await ctx.db.collection("subscriptions").doc(ctx.userId).get();
    let stripeCustomerId = subDoc.data()?.stripeCustomerId;
    // Create Stripe customer if needed
    if (!stripeCustomerId) {
        const customer = await stripe.customers.create({
            metadata: { firebaseUserId: ctx.userId },
        });
        stripeCustomerId = customer.id;
        // Ensure subscription doc exists
        if (!subDoc.exists) {
            await ctx.db.collection("subscriptions").doc(ctx.userId).set({
                ...(0, config_1.createDefaultSubscriptionData)(ctx.userId),
                stripeCustomerId,
            });
        }
        else {
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
        throw new createCallable_1.HttpsError("internal", "Failed to create checkout session");
    }
    return { checkoutUrl: session.url };
});
//# sourceMappingURL=createCheckoutSession.js.map