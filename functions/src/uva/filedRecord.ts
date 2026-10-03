/**
 * What was actually filed for a period, and how a later run compares (#564,
 * D11-D16).
 *
 * FiBuKI recomputes a period every time it is opened. A fix to a rule — the
 * refunds of #564 are the first — moves the figures of a quarter that was
 * already filed, and before this record nothing said what had been filed, so
 * the move was silent. Mark as filed keeps the figures the User submitted
 * (edited by hand where the filing was hand-corrected), and a later run is
 * compared against them: per Kennzahl, whether the amount payable moved, and
 * the Transactions whose derivation changed.
 *
 * Records are append-only. Filing a corrected UVA adds a record; the earlier
 * one stays as the history of what was filed. Whether to file a correction is
 * the User's and the Tax Advisor's decision: this informs, it never files.
 *
 * Pure: records and runs in, comparisons out.
 */

import { movedEntries, periodKeyOf, reconcileDerivations, snapshotDerivations } from "./reconcile";
import type { DerivationMovement, UvaDerivationSnapshot } from "./reconcile";
import type { UvaPeriod, UvaReportResult } from "./types";

/** How the figures were recorded as filed. */
export type FiledRecordSource = "mark-as-filed" | "finanzonline";

export interface UvaFiledRecord {
  periodKey: string;
  period: UvaPeriod;
  /** The figures filed, cents, per Kennzahl, KZ 095 included. */
  kennzahlen: Record<string, number>;
  /** What FiBuKI calculated when it was filed, for the same codes. */
  calculated: Record<string, number>;
  /** At least one filed figure differs from the calculated one. */
  editedByHand: boolean;
  source: FiledRecordSource;
  /** ISO timestamp of the record. */
  filedAt: string;
  /** Who recorded it. */
  filedBy: string;
  /** FinanzOnline's reference, on a direct submission. */
  referenceNumber?: string | null;
  note?: string | null;
}

export interface KennzahlDelta {
  code: string;
  filed: number;
  now: number;
  delta: number;
}

/** A filed period against a fresh run of it. */
export interface FiledComparison {
  periodKey: string;
  period: UvaPeriod;
  filedAt: string;
  /** Every Kennzahl whose figure differs, in code order. Empty = nothing moved. */
  deltas: KennzahlDelta[];
  moved: boolean;
  /**
   * The amount payable (KZ 095) moved: a corrected UVA would mean more (or
   * less) tax, not only amounts moving between Kennzahlen.
   */
  balanceMoved: boolean;
  balanceDelta: number;
  /** The Transactions whose derivation changed since the filing. */
  transactions: DerivationMovement[];
}

/** A run's Kennzahlen as plain cents, the shape a filing records. */
export function kennzahlValues(result: UvaReportResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [code, figure] of Object.entries(result.kennzahlen)) out[code] = figure.value;
  return out;
}

/** A Kennzahl code as the U30 numbers it: three digits. */
const KZ_CODE = /^\d{3}$/;

/**
 * The figures a person says were filed. Codes are three digits and values
 * whole cents; anything else is refused rather than stored, because a filed
 * record that cannot be compared is no record. KZ 095 is required: the
 * amount payable is the one figure a filing always has.
 */
export function validateFiledKennzahlen(input: unknown): Record<string, number> | string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "kennzahlen must be an object";
  const out: Record<string, number> = {};
  for (const [code, value] of Object.entries(input as Record<string, unknown>)) {
    if (!KZ_CODE.test(code)) return `Kennzahl "${code}" is not a three-digit code`;
    if (typeof value !== "number" || !Number.isInteger(value)) return `KZ ${code} must be whole cents`;
    out[code] = value;
  }
  if (!("095" in out)) return "KZ 095 (the amount payable) is required";
  return out;
}

/** True when the filed figures differ from the calculated ones on any code. */
export function differsFrom(filed: Record<string, number>, calculated: Record<string, number>): boolean {
  const codes = new Set([...Object.keys(filed), ...Object.keys(calculated)]);
  for (const code of codes) if ((filed[code] ?? 0) !== (calculated[code] ?? 0)) return true;
  return false;
}

/**
 * Compare what was filed with a fresh run of the same period. The
 * Transactions are compared on the derivation kept with the record, so the
 * list says which lines moved the figures, not only that they moved.
 */
export function compareWithFiled(
  filed: Pick<UvaFiledRecord, "periodKey" | "period" | "filedAt" | "kennzahlen">,
  filedSnapshot: UvaDerivationSnapshot | null,
  now: UvaReportResult
): FiledComparison {
  const current = kennzahlValues(now);
  const codes = [...new Set([...Object.keys(filed.kennzahlen), ...Object.keys(current)])].sort();
  const deltas: KennzahlDelta[] = [];
  for (const code of codes) {
    const f = filed.kennzahlen[code] ?? 0;
    const n = current[code] ?? 0;
    if (f !== n) deltas.push({ code, filed: f, now: n, delta: n - f });
  }
  const balanceDelta = (current["095"] ?? 0) - (filed.kennzahlen["095"] ?? 0);
  const transactions =
    filedSnapshot && filedSnapshot.periodKey === periodKeyOf(now.period)
      ? movedEntries(reconcileDerivations(filedSnapshot, snapshotDerivations(now)))
      : [];
  return {
    periodKey: filed.periodKey,
    period: filed.period,
    filedAt: filed.filedAt,
    deltas,
    moved: deltas.length > 0,
    balanceMoved: balanceDelta !== 0,
    balanceDelta,
    transactions,
  };
}
