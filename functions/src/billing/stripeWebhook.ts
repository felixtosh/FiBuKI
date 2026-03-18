/**
 * Stripe Webhook Handler
 *
 * Receives Stripe events for subscription lifecycle management.
 * Uses onRequest (not createCallable) since Stripe sends raw HTTP requests.
 *
 * Hardening:
 * - Event deduplication via Firestore stripeEvents collection (prevents double-processing)
 * - Always returns 200 to Stripe (prevents 72-hour retry loops on transient errors)
 * - Handler errors logged to stripeWebhookErrors collection for manual review
 */

import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import Stripe from "stripe";
import { PLANS } from "./config";
import type { PlanId, BillingPeriod } from "./config";
import { clearQuotaExceeded } from "./clearQuotaExceeded";

const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");

/**
 * Check if an event has already been processed (idempotency guard).
 * Returns true if this is a duplicate event that should be skipped.
 */
async function isDuplicateEvent(
  db: FirebaseFirestore.Firestore,
  eventId: string
): Promise<boolean> {
  const ref = db.collection("stripeEvents").doc(eventId);
  const doc = await ref.get();
  if (doc.exists) return true;

  // Mark as processing. TTL-based cleanup can purge old docs.
  await ref.set({
    processedAt: FieldValue.serverTimestamp(),
    // Firestore TTL policy: set expireAt for auto-cleanup after 7 days
    expireAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
  return false;
}

/**
 * Log webhook handler errors for manual review (instead of returning 500 to Stripe).
 */
async function logWebhookError(
  db: FirebaseFirestore.Firestore,
  eventId: string,
  eventType: string,
  error: unknown
) {
  try {
    await db.collection("stripeWebhookErrors").add({
      eventId,
      eventType,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (logErr) {
    // Last resort: if even logging fails, at least we have console
    console.error("[StripeWebhook] Failed to log error:", logErr);
  }
}

export const stripeWebhook = onRequest(
  {
    region: "europe-west1",
    secrets: [stripeSecretKey, stripeWebhookSecret],
    cors: false,
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const stripe = new Stripe(stripeSecretKey.value());
    const sig = req.headers["stripe-signature"];

    if (!sig) {
      res.status(400).send("Missing stripe-signature header");
      return;
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        sig,
        stripeWebhookSecret.value()
      );
    } catch (err) {
      console.error("[StripeWebhook] Signature verification failed:", err);
      res.status(400).send("Webhook signature verification failed");
      return;
    }

    const db = getFirestore();

    // Idempotency: skip duplicate events (Stripe retries on timeout)
    if (await isDuplicateEvent(db, event.id)) {
      console.log(`[StripeWebhook] Duplicate event skipped: ${event.id} (${event.type})`);
      res.status(200).json({ received: true, deduplicated: true });
      return;
    }

    // Always return 200 to Stripe — log errors internally instead of triggering retries
    try {
      switch (event.type) {
        case "checkout.session.completed":
          await handleCheckoutCompleted(db, event.data.object as Stripe.Checkout.Session);
          break;

        case "customer.subscription.updated":
          await handleSubscriptionUpdated(db, event.data.object as Stripe.Subscription);
          break;

        case "customer.subscription.deleted":
          await handleSubscriptionDeleted(db, event.data.object as Stripe.Subscription);
          break;

        case "invoice.payment_succeeded":
          await handleInvoicePaymentSucceeded(db, stripe, event.data.object as Stripe.Invoice);
          break;

        case "invoice.payment_failed":
          await handleInvoicePaymentFailed(db, stripe, event.data.object as Stripe.Invoice);
          break;

        default:
          console.log(`[StripeWebhook] Unhandled event type: ${event.type}`);
      }
    } catch (error) {
      // Log error for manual review but still return 200 to prevent Stripe retry storms
      console.error(`[StripeWebhook] Error handling ${event.type}:`, error);
      await logWebhookError(db, event.id, event.type, error);
    }

    res.status(200).json({ received: true });
  }
);

// =============================================================================
// Event Handlers
// =============================================================================

async function handleCheckoutCompleted(
  db: FirebaseFirestore.Firestore,
  session: Stripe.Checkout.Session
) {
  const userId = session.metadata?.userId;
  if (!userId) {
    console.error("[StripeWebhook] checkout.session.completed missing userId metadata");
    return;
  }

  // Handle country backing payment
  if (session.metadata?.type === "country_backing") {
    await handleCountryBacking(db, session);
    return;
  }

  // Handle AI credits purchase
  if (session.metadata?.type === "ai_credits") {
    const rawAmount = session.metadata.amountEur;
    const amountEur = parseFloat(rawAmount || "0");
    if (!rawAmount || !Number.isFinite(amountEur) || amountEur <= 0) {
      console.error(
        `[StripeWebhook] AI credits checkout has invalid amountEur: "${rawAmount}" user=${userId} session=${session.id}`
      );
      // Store for manual review — user paid but credits couldn't be applied
      await db.collection("stripeWebhookErrors").add({
        eventType: "checkout.session.completed",
        reason: "invalid_credit_amount",
        userId,
        sessionId: session.id,
        rawAmountEur: rawAmount ?? null,
        createdAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    await db.collection("subscriptions").doc(userId).update({
      aiCreditsEur: FieldValue.increment(amountEur),
      aiPaused: false, // Un-pause when credits are added
      updatedAt: FieldValue.serverTimestamp(),
    });
    console.log(`[StripeWebhook] AI credits added: user=${userId} amount=${amountEur}`);
    return;
  }

  const plan = (session.metadata?.plan || "data") as PlanId;
  const billingPeriod = (session.metadata?.billingPeriod || "monthly") as BillingPeriod;
  const planConfig = PLANS[plan] || PLANS.data;

  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : (session.subscription as Stripe.Subscription | null)?.id || null;

  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : (session.customer as Stripe.Customer | null)?.id || null;

  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setMonth(periodEnd.getMonth() + (billingPeriod === "yearly" ? 12 : 1));
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  await db.collection("subscriptions").doc(userId).set(
    {
      userId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      stripeSubscriptionStatus: "active",
      plan,
      billingPeriod,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      aiFairUseLimitEur: planConfig.aiFairUseLimitEur,
      aiUsageCurrentPeriodEur: 0,
      aiOverageCurrentPeriodEur: 0,
      aiPaused: false,
      aiWarning90Sent: false,
      aiWarning100Sent: false,
      transactionCountCurrentMonth: 0,
      transactionCountMonth: yearMonth,
      // Mark trial as expired on first paid checkout
      trialExpired: true,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // Clear quotaExceeded flags — user upgraded, previously limited transactions should be active
  clearQuotaExceeded(userId).catch((err) =>
    console.error("[StripeWebhook] Failed to clear quotaExceeded:", err)
  );

  console.log(`[StripeWebhook] Checkout completed: user=${userId} plan=${plan}`);
}

async function handleSubscriptionUpdated(
  db: FirebaseFirestore.Firestore,
  subscription: Stripe.Subscription
) {
  const userId = subscription.metadata?.userId;
  if (!userId) {
    console.error("[StripeWebhook] subscription.updated missing userId metadata");
    return;
  }

  // Skip plan changes if admin override is set (prevents Stripe from overwriting admin-set plans)
  const subDoc = await db.collection("subscriptions").doc(userId).get();
  if (subDoc.exists && subDoc.data()?.adminOverride) {
    console.log(`[StripeWebhook] Skipping subscription update for user=${userId} (adminOverride=${subDoc.data()?.adminOverride})`);
    return;
  }

  const plan = (subscription.metadata?.plan || "data") as PlanId;
  const planConfig = PLANS[plan] || PLANS.data;

  await db.collection("subscriptions").doc(userId).update({
    plan,
    stripeSubscriptionStatus: subscription.status as "active" | "past_due" | "canceled",
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    aiFairUseLimitEur: planConfig.aiFairUseLimitEur,
    updatedAt: FieldValue.serverTimestamp(),
  });

  console.log(`[StripeWebhook] Subscription updated: user=${userId} plan=${plan} status=${subscription.status}`);
}

async function handleSubscriptionDeleted(
  db: FirebaseFirestore.Firestore,
  subscription: Stripe.Subscription
) {
  const userId = subscription.metadata?.userId;
  if (!userId) {
    console.error("[StripeWebhook] subscription.deleted missing userId metadata");
    return;
  }

  const freePlan = PLANS.free;

  await db.collection("subscriptions").doc(userId).update({
    plan: "free",
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: "canceled",
    cancelAtPeriodEnd: false,
    aiFairUseLimitEur: freePlan.aiFairUseLimitEur,
    aiOverageCapEur: 0,
    updatedAt: FieldValue.serverTimestamp(),
  });

  console.log(`[StripeWebhook] Subscription deleted (downgraded to free): user=${userId}`);
}

async function handleInvoicePaymentSucceeded(
  db: FirebaseFirestore.Firestore,
  _stripe: Stripe,
  invoice: Stripe.Invoice
) {
  // Only reset counters for subscription invoices (not one-time credit purchases)
  const subscriptionId = invoice.parent?.subscription_details?.subscription;
  if (!subscriptionId) return;

  // Find user by subscription ID
  const subQuery = await db
    .collection("subscriptions")
    .where("stripeSubscriptionId", "==", subscriptionId)
    .limit(1)
    .get();

  if (subQuery.empty) {
    console.warn(`[StripeWebhook] No subscription found for stripeSubscriptionId=${subscriptionId}`);
    return;
  }

  const subDoc = subQuery.docs[0];
  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  // Derive period from the invoice's own line items (avoids extra Stripe API call).
  // Invoice lines contain the subscription period that was just paid for.
  const firstLine = invoice.lines?.data?.[0];
  const periodStart = firstLine?.period?.start
    ? new Date(firstLine.period.start * 1000)
    : now;
  const periodEnd = firstLine?.period?.end
    ? new Date(firstLine.period.end * 1000)
    : new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());

  await subDoc.ref.update({
    stripeSubscriptionStatus: "active",
    aiUsageCurrentPeriodEur: 0,
    aiOverageCurrentPeriodEur: 0,
    aiPaused: false,
    aiWarning90Sent: false,
    aiWarning100Sent: false,
    transactionCountCurrentMonth: 0,
    transactionCountMonth: yearMonth,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    updatedAt: FieldValue.serverTimestamp(),
  });

  console.log(`[StripeWebhook] Invoice paid, counters reset: user=${subDoc.id}`);

  // Credit referrer on the referred user's first paid invoice
  await creditReferrer(db, _stripe, subDoc.id, subDoc.data());
}

async function handleInvoicePaymentFailed(
  db: FirebaseFirestore.Firestore,
  stripe: Stripe,
  invoice: Stripe.Invoice
) {
  const subscriptionId = invoice.parent?.subscription_details?.subscription;
  if (!subscriptionId) return;

  const subQuery = await db
    .collection("subscriptions")
    .where("stripeSubscriptionId", "==", subscriptionId)
    .limit(1)
    .get();

  if (subQuery.empty) return;

  await subQuery.docs[0].ref.update({
    stripeSubscriptionStatus: "past_due",
    updatedAt: FieldValue.serverTimestamp(),
  });

  console.log(`[StripeWebhook] Invoice payment failed: user=${subQuery.docs[0].id}`);
}

// =============================================================================
// Referral Credit Handler
// =============================================================================

async function creditReferrer(
  db: FirebaseFirestore.Firestore,
  stripe: Stripe,
  referredUserId: string,
  subData: FirebaseFirestore.DocumentData | undefined
) {
  const referredBy = subData?.referredBy;
  if (!referredBy) return;

  try {
    // Find the pending conversion for this referred user
    const convQuery = await db
      .collection("referralConversions")
      .where("referredUserId", "==", referredUserId)
      .where("status", "==", "pending")
      .limit(1)
      .get();

    if (convQuery.empty) return;

    const convDoc = convQuery.docs[0];
    const conversion = convDoc.data();

    // Get the referrer's subscription to find their Stripe customer ID
    const referrerSub = await db
      .collection("subscriptions")
      .doc(conversion.referrerUserId)
      .get();

    const referrerCustomerId = referrerSub.data()?.stripeCustomerId;
    if (!referrerCustomerId) {
      console.warn(`[StripeWebhook] Referrer ${conversion.referrerUserId} has no Stripe customer`);
      return;
    }

    // Determine credit amount: one month of the referrer's current plan
    const referrerPlan = referrerSub.data()?.plan || "smart";
    const planConfig = PLANS[referrerPlan as PlanId] || PLANS.smart;
    const creditCents = Math.round(planConfig.monthlyPriceEur * 100);

    // Apply negative balance (credit) to referrer's Stripe customer
    await stripe.customers.createBalanceTransaction(referrerCustomerId, {
      amount: -creditCents,
      currency: "eur",
      description: `Referral credit: ${conversion.referralCode}`,
    });

    // Update conversion status
    await convDoc.ref.update({
      status: "converted",
      referrerCreditApplied: true,
      convertedAt: FieldValue.serverTimestamp(),
    });

    console.log(
      `[StripeWebhook] Referral credit applied: referrer=${conversion.referrerUserId} ` +
      `amount=${creditCents}c code=${conversion.referralCode}`
    );
  } catch (err) {
    console.error("[StripeWebhook] Failed to credit referrer:", err);
    // Don't throw — referral credit failure shouldn't break the invoice handler
  }
}

// =============================================================================
// Country Backing Handler
// =============================================================================

async function handleCountryBacking(
  db: FirebaseFirestore.Firestore,
  session: Stripe.Checkout.Session
) {
  const countryCode = session.metadata?.countryCode;
  const email = session.metadata?.email;
  const userId = session.metadata?.userId || undefined;

  if (!countryCode || !email) {
    console.error("[StripeWebhook] country_backing missing countryCode or email metadata");
    return;
  }

  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent as Stripe.PaymentIntent | null)?.id;

  if (!paymentIntentId) {
    console.error("[StripeWebhook] country_backing missing payment_intent");
    return;
  }

  // Create backer document
  await db.collection("countryBackers").add({
    countryCode,
    email,
    ...(userId ? { userId } : {}),
    stripePaymentIntentId: paymentIntentId,
    amount: session.amount_total || 1000,
    status: "paid",
    createdAt: FieldValue.serverTimestamp(),
  });

  // Increment counters on the country doc (atomic)
  const countryRef = db.collection("countryExpansion").doc(countryCode);
  await countryRef.update({
    currentBackers: FieldValue.increment(1),
    totalCommitted: FieldValue.increment(session.amount_total || 1000),
  });

  console.log(`[StripeWebhook] Country backing recorded: ${countryCode} by ${email}`);
}
