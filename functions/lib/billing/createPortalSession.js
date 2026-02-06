"use strict";
/**
 * Create a Stripe Customer Portal session for managing subscriptions.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPortalSessionCallable = void 0;
const stripe_1 = __importDefault(require("stripe"));
const params_1 = require("firebase-functions/params");
const createCallable_1 = require("../utils/createCallable");
const stripeSecretKey = (0, params_1.defineSecret)("STRIPE_SECRET_KEY");
exports.createPortalSessionCallable = (0, createCallable_1.createCallable)({
    name: "createPortalSession",
    secrets: [stripeSecretKey],
}, async (ctx, request) => {
    const { returnUrl } = request;
    if (!returnUrl) {
        throw new createCallable_1.HttpsError("invalid-argument", "returnUrl is required");
    }
    const subDoc = await ctx.db.collection("subscriptions").doc(ctx.userId).get();
    const stripeCustomerId = subDoc.data()?.stripeCustomerId;
    if (!stripeCustomerId) {
        throw new createCallable_1.HttpsError("failed-precondition", "No Stripe customer found. Please subscribe to a plan first.");
    }
    const stripe = new stripe_1.default(stripeSecretKey.value());
    const session = await stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: returnUrl,
    });
    return { portalUrl: session.url };
});
//# sourceMappingURL=createPortalSession.js.map