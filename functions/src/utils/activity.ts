/**
 * The activity log of a Transaction or a File (#752): `automationHistory`, one
 * entry per change an algorithm, an LLM or a person made to the item.
 *
 * The rule: an entry is written when something changes what the User sees on
 * the item: a value set or cleared, suggestions that appear or whose top
 * choice changes. A run that changes nothing writes nothing, so the log stays
 * readable and the document small. Derived bookkeeping (`documentationState`,
 * the `isComplete` sync, quota flags) is not logged.
 *
 * Every writer builds its entry here, so the shape, the timestamp and the
 * level are the same whoever wrote it.
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";

/** Who made the change. The chat agent and external AI clients are `ai`. */
export type ActivityActor = "auto" | "ai" | "manual" | "suggestion";

export type ActivityLevel = "decision" | "outcome" | "info";

export interface ActivityInput {
  /** What happened, e.g. `partner_assigned`, `extracted`, `suggestions_updated`. */
  type: string;
  actor: ActivityActor;
  /** One line a person can read in the log. */
  summary: string;
  status?: "completed" | "failed" | "no_match" | "pending" | "skipped";
  /** Overrides the level derived from the actor. */
  level?: ActivityLevel;
  partnerName?: string | null;
  forPartnerId?: string | null;
  fileId?: string | null;
  fileName?: string | null;
  transactionId?: string | null;
  transactionName?: string | null;
  categoryName?: string | null;
  confidence?: number | null;
  workerRunId?: string | null;
}

/** Suggestion and telemetry entries are info; anything else an algorithm or AI did is an outcome; a person's is a decision. */
export function activityLevelFor(input: Pick<ActivityInput, "type" | "actor" | "level">): ActivityLevel {
  if (input.level) return input.level;
  if (input.type.endsWith("_suggested") || input.type === "suggestions_updated") return "info";
  return input.actor === "auto" || input.actor === "ai" ? "outcome" : "decision";
}

/** One log entry, ready for `automationHistory`. Absent fields are left out, never written as undefined. */
export function activityEntry(input: ActivityInput, at: Timestamp = Timestamp.now()): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    type: input.type,
    actor: input.actor,
    summary: input.summary,
    status: input.status ?? "completed",
    ranAt: at,
    level: activityLevelFor(input),
  };
  for (const key of [
    "partnerName",
    "forPartnerId",
    "fileId",
    "fileName",
    "transactionId",
    "transactionName",
    "categoryName",
    "confidence",
    "workerRunId",
  ] as const) {
    const value = input[key];
    if (value !== undefined && value !== null) entry[key] = value;
  }
  return entry;
}

/** The field to merge into an update so the entries are appended to the item's log. */
export function logActivity(...entries: Array<Record<string, unknown>>): { automationHistory: FieldValue } {
  return { automationHistory: FieldValue.arrayUnion(...entries) };
}
