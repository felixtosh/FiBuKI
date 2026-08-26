import type {
  DeclaredBillingCycle,
  EffectiveBillingCycle,
  UserPartner,
} from "@/types/partner";

/** A named cadence, or `custom` for a partner billing on its own interval. */
export type CadenceName = "weekly" | "monthly" | "quarterly" | "yearly" | "custom";

/** Where today sits relative to the next expected charge. */
export type ChargeWindowState = "upcoming" | "due" | "overdue" | "unknown";

/** How completely a recurrence's charges carry what they are expected to. */
export type CoverageState = "complete" | "partial" | "none" | "empty";

export declare const CADENCE_DAYS: Record<
  Exclude<CadenceName, "custom">,
  number
>;

export declare const CADENCE_TOLERANCE_DAYS: number;

export declare function cadenceOf(frequencyDays: unknown): CadenceName | null;

export declare function isRecurringPartner(
  partner: Pick<UserPartner, "billingCycle"> | null | undefined,
): boolean;

export declare function chargeWindowState(
  window: { from?: Date; to?: Date } | null | undefined,
  today: Date,
): ChargeWindowState;

export declare function coverageState(
  coverage: { charges?: number; missing?: number } | null | undefined,
): CoverageState;

export declare function declarationFor(
  declared: readonly DeclaredBillingCycle[] | null | undefined,
  band: EffectiveBillingCycle | null | undefined,
): DeclaredBillingCycle | null;
