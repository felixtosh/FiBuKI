/**
 * Is a partner a recurring biller, or just somewhere the user shops often?
 *
 * The interval arithmetic in ./billingCycle.ts finds any partner charged at
 * a steady rhythm, and a supermarket, Amazon or the App Store has one: four
 * similar amounts a few days apart read as "weekly". A recurrence is a
 * promise that a document will follow every charge, so a false one marks
 * groceries as "document missing". Whether the rhythm is a contract
 * (subscription, rent, insurance, membership, loan) or a habit is a question
 * about the partner, not the dates, so a model answers it.
 *
 * The verdict is cached on the partner (billingCycle.recurrence) and asked
 * again only when what it was asked about changes, so the nightly re-learn
 * of every partner costs a model call only for partners that are new or
 * changed.
 */

import { Timestamp } from "firebase-admin/firestore";
import { MODELS } from "../utils/models";
import { logAIUsage } from "../utils/ai-usage-logger";
import { checkAIBudget } from "../billing/checkAIBudget";
import type { DerivedBillingCycle } from "./billingCycle";

const MODEL = MODELS.geminiLite;
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || "europe-west1";

/** A cached verdict older than this is asked again. */
const VERDICT_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

/** Charges shown to the model, newest first. */
const SAMPLE_CHARGES = 12;

export interface RecurrenceVerdict {
  recurring: boolean;
  reason: string;
  /** What was asked: a changed key means the cached verdict is stale. */
  key: string;
  model: string;
  checkedAt: Timestamp;
}

export interface RecurrenceCheckInput {
  partnerName: string;
  aliases: string[];
  website: string | null;
  cycles: DerivedBillingCycle[];
  /** Newest first. Amounts in the account currency, signed. */
  charges: Array<{ date: Date; amount: number; description: string }>;
}

/** Same partner, same cadences: the cached answer still applies. */
export function recurrenceKey(input: RecurrenceCheckInput): string {
  const cadences = input.cycles.map((c) => c.frequencyDays).sort((a, b) => a - b);
  return `${input.partnerName.trim().toLowerCase()}|${cadences.join(",")}`;
}

export function isVerdictFresh(cached: unknown, key: string, now = Date.now()): cached is RecurrenceVerdict {
  if (!cached || typeof cached !== "object") return false;
  const v = cached as Partial<RecurrenceVerdict>;
  if (typeof v.recurring !== "boolean" || v.key !== key) return false;
  const checkedAt = v.checkedAt as { toMillis?: () => number } | undefined;
  return typeof checkedAt?.toMillis === "function" && now - checkedAt.toMillis() < VERDICT_MAX_AGE_MS;
}

export function buildRecurrencePrompt(input: RecurrenceCheckInput): string {
  const cycles = input.cycles
    .map((c) => {
      const amount = c.amountBand !== undefined ? `, around ${(Math.abs(c.amountBand) / 100).toFixed(2)}` : "";
      return `- every ~${c.frequencyDays} days${amount} (${c.sampleSize} charges)`;
    })
    .join("\n");
  const charges = input.charges
    .slice(0, SAMPLE_CHARGES)
    .map((c) => `- ${c.date.toISOString().slice(0, 10)}  ${(c.amount / 100).toFixed(2)}  ${c.description}`)
    .join("\n");

  return `You classify a merchant on an Austrian sole trader's bank account.

Merchant: ${input.partnerName}
Aliases: ${input.aliases.length > 0 ? input.aliases.join(", ") : "none"}
Website: ${input.website || "unknown"}

Charges repeat at a steady rhythm:
${cycles}

Recent charges (date, amount, bank text):
${charges}

Is this a RECURRING BILLING relationship, where the merchant charges on a schedule under a contract or plan and each charge comes with its own invoice? Examples: software or media subscriptions, phone and internet, rent, leasing, insurance, memberships, loan instalments, utilities, usage-based API billing.

Or are these SEPARATE PURCHASES that just happen often? Examples: supermarkets, drugstores, petrol stations, restaurants, marketplaces like Amazon, app store purchases, taxis, public transport tickets.

A merchant that sells both (e.g. Apple: iCloud subscription vs. app purchases) counts as recurring only if the amounts above look like the plan price rather than varied purchases.

Answer JSON only: {"recurring": true|false, "reason": "<one short sentence>"}`;
}

export function parseRecurrenceAnswer(text: string): { recurring: boolean; reason: string } | null {
  let json = text.trim();
  const fenced = json.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) json = fenced[1].trim();
  try {
    const parsed = JSON.parse(json) as { recurring?: unknown; reason?: unknown };
    if (typeof parsed.recurring !== "boolean") return null;
    return {
      recurring: parsed.recurring,
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 300) : "",
    };
  } catch {
    return null;
  }
}

function getProjectId(): string {
  return process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
}

/**
 * Ask the model. Null when it cannot answer (no AI budget, a provider error,
 * an unparseable reply): the caller then treats the cycle as unconfirmed.
 */
export async function checkRecurrence(
  userId: string,
  partnerId: string,
  input: RecurrenceCheckInput
): Promise<RecurrenceVerdict | null> {
  const budget = await checkAIBudget(userId);
  if (!budget.allowed) {
    console.log(`[BillingCycle] AI budget exhausted for user ${userId}, recurrence of ${partnerId} unchecked`);
    return null;
  }

  try {
    const { VertexAI } = await import("@google-cloud/vertexai");
    const vertexAI = new VertexAI({ project: getProjectId(), location: VERTEX_LOCATION });
    const model = vertexAI.getGenerativeModel({ model: MODEL });
    const result = await model.generateContent({
      generationConfig: { responseMimeType: "application/json" },
      contents: [{ role: "user", parts: [{ text: buildRecurrencePrompt(input) }] }],
    });

    const usage = result.response.usageMetadata;
    if (usage) {
      await logAIUsage(userId, {
        function: "classification",
        model: MODEL,
        inputTokens: usage.promptTokenCount || 0,
        outputTokens: usage.candidatesTokenCount || 0,
        metadata: { partnerId },
      });
    }

    const answer = parseRecurrenceAnswer(result.response.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
    if (!answer) {
      console.warn(`[BillingCycle] Unparseable recurrence answer for partner ${partnerId}`);
      return null;
    }
    return { ...answer, key: recurrenceKey(input), model: MODEL, checkedAt: Timestamp.now() };
  } catch (error) {
    console.warn(`[BillingCycle] Recurrence check failed for partner ${partnerId}:`, error);
    return null;
  }
}
