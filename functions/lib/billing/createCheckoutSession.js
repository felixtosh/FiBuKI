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
    // Check for referral discount (yearly plans only)
    const discounts = [];
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
            }
            else {
                // Create a Stripe promotion code for this referral
                try {
                    // Find or create the referral coupon
                    let couponId = "referral_20_off_yearly";
                    try {
                        await stripe.coupons.retrieve(couponId);
                    }
                    catch {
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
                }
                catch (err) {
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
        throw new createCallable_1.HttpsError("internal", "Failed to create checkout session");
    }
    return { checkoutUrl: session.url };
});
//# sourceMappingURL=createCheckoutSession.js.map