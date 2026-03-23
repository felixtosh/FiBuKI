/**
 * Aggregate user partner insights into global partner behavioralInsights.
 *
 * Scheduled weekly or triggered by admin. For each globalPartner:
 * 1. Find all user partners linked via globalPartnerId
 * 2. Aggregate billingCycle → consensus frequency
 * 3. Aggregate scoringWeights → weighted average
 * 4. Aggregate resolutionPreference → consensus type
 * 5. Aggregate emailDomains → union of confirmed domains
 * 6. Store as behavioralInsights on globalPartner
 */

import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { onSchedule } from "firebase-functions/v2/scheduler";

const db = getFirestore();

interface AggregateGlobalInsightsRequest {
  /** If provided, only aggregate this one global partner */
  globalPartnerId?: string;
  /** Max global partners to process (default 100) */
  limit?: number;
}

interface AggregateGlobalInsightsResponse {
  success: boolean;
  processed: number;
  updated: number;
}

/**
 * Callable version (for admin trigger)
 */
export const aggregateGlobalInsightsCallable = createCallable<
  AggregateGlobalInsightsRequest,
  AggregateGlobalInsightsResponse
>(
  { name: "aggregateGlobalInsights" },
  async (ctx, request) => {
    // Verify admin
    // Note: createCallable handles auth, but this is admin-only
    const userDoc = await ctx.db.collection("users").doc(ctx.userId).get();
    const isAdmin = userDoc.data()?.admin === true || ctx.request.auth?.token?.email === process.env.SUPER_ADMIN_EMAIL;
    if (!isAdmin) {
      throw new HttpsError("permission-denied", "Admin only");
    }

    return aggregateInsights(request.globalPartnerId, request.limit || 100);
  }
);

/**
 * Scheduled version (weekly)
 */
export const scheduledAggregateGlobalInsights = onSchedule(
  {
    schedule: "every monday 03:00",
    region: "europe-west1",
    timeoutSeconds: 300,
  },
  async () => {
    console.log("[GlobalInsights] Starting scheduled aggregation");
    const result = await aggregateInsights(undefined, 500);
    console.log(`[GlobalInsights] Done: ${result.processed} processed, ${result.updated} updated`);
  }
);

async function aggregateInsights(
  globalPartnerId?: string,
  limit: number = 100
): Promise<AggregateGlobalInsightsResponse> {
  // Get global partners to process
  let query = db.collection("globalPartners").where("isActive", "==", true);
  if (globalPartnerId) {
    // Process just one
    const doc = await db.collection("globalPartners").doc(globalPartnerId).get();
    if (!doc.exists) {
      return { success: true, processed: 0, updated: 0 };
    }
    const result = await processOneGlobalPartner(doc);
    return { success: true, ...result };
  }

  const snap = await query.limit(limit).get();
  let processed = 0;
  let updated = 0;

  for (const doc of snap.docs) {
    const result = await processOneGlobalPartner(doc);
    processed += result.processed;
    updated += result.updated;
  }

  return { success: true, processed, updated };
}

async function processOneGlobalPartner(
  globalDoc: FirebaseFirestore.DocumentSnapshot
): Promise<{ processed: number; updated: number }> {
  const globalId = globalDoc.id;

  // Find all user partners linked to this global partner
  const userPartnersSnap = await db
    .collection("partners")
    .where("globalPartnerId", "==", globalId)
    .where("isActive", "==", true)
    .limit(100)
    .get();

  if (userPartnersSnap.size < 2) {
    // Need at least 2 users for meaningful consensus
    return { processed: 1, updated: 0 };
  }

  const userPartners = userPartnersSnap.docs.map((d) => d.data());

  // 1. Aggregate billing frequency
  const frequencies: number[] = [];
  const invoiceDelays: number[] = [];
  for (const p of userPartners) {
    if (p.billingCycle?.frequencyDays) {
      frequencies.push(p.billingCycle.frequencyDays);
    }
    if (p.billingCycle?.invoiceToTransactionDelay != null) {
      invoiceDelays.push(p.billingCycle.invoiceToTransactionDelay);
    }
  }

  let billingFrequency: string | undefined;
  if (frequencies.length >= 2) {
    const modeFreq = computeMode(frequencies);
    if (modeFreq <= 35) billingFrequency = "monthly";
    else if (modeFreq <= 100) billingFrequency = "quarterly";
    else if (modeFreq <= 400) billingFrequency = "yearly";
    else billingFrequency = "irregular";
  }

  const typicalInvoiceDelay =
    invoiceDelays.length >= 2
      ? Math.round(invoiceDelays.reduce((s, d) => s + d, 0) / invoiceDelays.length)
      : undefined;

  // 2. Aggregate scoring weights (weighted average by sampleSize)
  let defaultScoringWeights: { amountWeight: number; dateWeight: number; partnerWeight: number } | undefined;
  const weightsWithSamples = userPartners
    .filter((p) => p.scoringWeights?.sampleSize > 0)
    .map((p) => p.scoringWeights);

  if (weightsWithSamples.length >= 2) {
    const totalSamples = weightsWithSamples.reduce((s, w) => s + w.sampleSize, 0);
    defaultScoringWeights = {
      amountWeight: weightsWithSamples.reduce((s, w) => s + w.amountWeight * w.sampleSize, 0) / totalSamples,
      dateWeight: weightsWithSamples.reduce((s, w) => s + w.dateWeight * w.sampleSize, 0) / totalSamples,
      partnerWeight: weightsWithSamples.reduce((s, w) => s + w.partnerWeight * w.sampleSize, 0) / totalSamples,
    };
    // Round to 2 decimal places
    defaultScoringWeights.amountWeight = Math.round(defaultScoringWeights.amountWeight * 100) / 100;
    defaultScoringWeights.dateWeight = Math.round(defaultScoringWeights.dateWeight * 100) / 100;
    defaultScoringWeights.partnerWeight = Math.round(defaultScoringWeights.partnerWeight * 100) / 100;
  }

  // 3. Aggregate resolution preference
  const resolutionCounts = { file_required: 0, no_receipt: 0, mixed: 0 };
  for (const p of userPartners) {
    const type = p.resolutionPreference?.type;
    if (type === "file_required") resolutionCounts.file_required++;
    else if (type === "no_receipt") resolutionCounts.no_receipt++;
    else if (type === "mixed") resolutionCounts.mixed++;
  }
  const maxRes = Math.max(...Object.values(resolutionCounts));
  let typicalResolution: string | undefined;
  if (maxRes >= 2) {
    typicalResolution = Object.entries(resolutionCounts).find(([, v]) => v === maxRes)?.[0];
  }

  // 4. Aggregate email domains (union of all, minimum 2 users)
  const domainCounts = new Map<string, number>();
  for (const p of userPartners) {
    for (const domain of p.emailDomains || []) {
      domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
    }
  }
  const commonEmailDomains = [...domainCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([domain]) => domain);

  // 5. Compute amount variance from file connections
  // (simplified: use billingCycle dayVariance as proxy)
  const dayVariances = userPartners
    .filter((p) => p.billingCycle?.dayVariance != null)
    .map((p) => p.billingCycle.dayVariance);
  const avgVariance =
    dayVariances.length > 0
      ? dayVariances.reduce((s: number, v: number) => s + v, 0) / dayVariances.length
      : null;
  let amountVariance: "exact" | "low" | "medium" | "high" = "medium";
  if (avgVariance !== null) {
    if (avgVariance <= 1) amountVariance = "exact";
    else if (avgVariance <= 3) amountVariance = "low";
    else if (avgVariance <= 7) amountVariance = "medium";
    else amountVariance = "high";
  }

  // Build behavioral insights
  const behavioralInsights: Record<string, unknown> = {
    amountVariance,
    contributingUsers: userPartnersSnap.size,
    updatedAt: Timestamp.now(),
  };

  if (billingFrequency) behavioralInsights.billingFrequency = billingFrequency;
  if (typicalInvoiceDelay !== undefined) behavioralInsights.typicalInvoiceDelay = typicalInvoiceDelay;
  if (typicalResolution) behavioralInsights.typicalResolution = typicalResolution;
  if (commonEmailDomains.length > 0) behavioralInsights.commonEmailDomains = commonEmailDomains;
  if (defaultScoringWeights) behavioralInsights.defaultScoringWeights = defaultScoringWeights;

  // Store on global partner
  await globalDoc.ref.update({
    behavioralInsights,
    updatedAt: Timestamp.now(),
  });

  console.log(
    `[GlobalInsights] Updated ${globalId}: ` +
    `${userPartnersSnap.size} users, freq=${billingFrequency || "N/A"}, ` +
    `delay=${typicalInvoiceDelay ?? "N/A"}d, res=${typicalResolution || "N/A"}`
  );

  return { processed: 1, updated: 1 };
}

function computeMode(values: number[]): number {
  const freq = new Map<number, number>();
  for (const v of values) {
    // Round to nearest 5 for grouping
    const rounded = Math.round(v / 5) * 5 || v;
    freq.set(rounded, (freq.get(rounded) || 0) + 1);
  }
  let mode = values[0];
  let maxFreq = 0;
  for (const [val, count] of freq) {
    if (count > maxFreq) {
      maxFreq = count;
      mode = val;
    }
  }
  return mode;
}
