/**
 * Reconciling one UVA run against an earlier one (#85).
 *
 * The D6 extraction sweep re-read 325 documents. 131 files improved and 29 came
 * back weaker, and the only reason that was knowable is that a snapshot was
 * taken BEFORE the sweep and diffed against the one after — on the derivation
 * SOURCE, not on field equality. The distinction is the whole module:
 *
 *  - a transaction whose rung moved (top-level → rate-groups) changed because
 *    the document is now being read differently, and the new figure is the
 *    better one by construction;
 *  - a transaction whose rung did NOT move but whose cents did changed because
 *    the same rung read the same document and got a different number, which is
 *    an extraction regression until someone says otherwise.
 *
 * Comparing figures alone collapses those two into "the number moved", which is
 * how a sweep costs 29 records and reads as noise. So every transaction on
 * either side becomes a movement carrying the fields that differ and the files
 * under it, and the movements account for the whole delta by construction —
 * there is no residual bucket for a figure to hide in.
 */

import type {
  TransactionDerivationEntry,
  UvaReportResult,
} from "./types";

/** A whole run's derivation record, keepable across sweeps. */
export interface UvaDerivationSnapshot {
  /** Period label, e.g. "2026-Q1" — a snapshot from another period is not comparable. */
  periodKey: string;
  entries: TransactionDerivationEntry[];
  totalInputVat: number;
  totalOutputVat: number;
  balance: number;
}

/**
 * What happened to one transaction between the two runs.
 *
 *  - appeared / disappeared  the transaction is on only one side
 *  - source-changed          the rung, the worklist reason or the connected
 *                            documents moved — the claim rests on something
 *                            else than it did
 *  - figure-changed          same source, different cents
 *  - unchanged               nothing moved
 */
export type MovementKind =
  | "appeared"
  | "disappeared"
  | "source-changed"
  | "figure-changed"
  | "unchanged";

/** Which fields differ. Empty for appeared/disappeared/unchanged. */
export type MovementField = "step" | "reason" | "files" | "inputVat" | "outputVat";

export interface DerivationMovement {
  transactionId: string;
  date: string;
  partner: string | null;
  kind: MovementKind;
  before: TransactionDerivationEntry | null;
  after: TransactionDerivationEntry | null;
  /** The fields that differ — what "explained" means when read by a rule. */
  changed: MovementField[];
  /**
   * The documents implicated: the union of both sides, so a file that was
   * disconnected is named as loudly as one that was added. This is the "per
   * file" half of explaining a movement.
   */
  fileIds: string[];
  inputVatDelta: number;
  outputVatDelta: number;
}

export interface UvaReconciliation {
  periodKey: string;
  /** Every transaction on either side, unchanged included. */
  movements: DerivationMovement[];
  totals: {
    inputVatBefore: number;
    inputVatAfter: number;
    inputVatDelta: number;
    outputVatBefore: number;
    outputVatAfter: number;
    outputVatDelta: number;
    balanceBefore: number;
    balanceAfter: number;
    balanceDelta: number;
  };
  /**
   * The movements sum to the totals' delta. False means a figure moved that no
   * transaction owns — a bug in the snapshot, never something to sign off.
   */
  accountedFor: boolean;
  /** The two snapshots cover the same period. */
  comparable: boolean;
}

/** Period label a snapshot is keyed by, e.g. "2026-Q1" / "2026-M03". */
export function periodKeyOf(p: { year: number; period: number; type: string }): string {
  return p.type === "quarterly"
    ? `${p.year}-Q${p.period}`
    : `${p.year}-M${String(p.period).padStart(2, "0")}`;
}

/**
 * Freeze a run. Nothing is recomputed: the result already carries the
 * per-transaction record the Kennzahlen were summed from, so a snapshot is a
 * projection rather than a second derivation.
 */
export function snapshotDerivations(result: UvaReportResult): UvaDerivationSnapshot {
  return {
    periodKey: periodKeyOf(result.period),
    entries: result.derivations.map((e) => ({ ...e, fileIds: [...e.fileIds] })),
    totalInputVat: result.totalInputVat,
    totalOutputVat: result.totalOutputVat,
    balance: result.balance,
  };
}

export function reconcileDerivations(
  before: UvaDerivationSnapshot,
  after: UvaDerivationSnapshot
): UvaReconciliation {
  const beforeById = new Map(before.entries.map((e) => [e.transactionId, e]));
  const afterById = new Map(after.entries.map((e) => [e.transactionId, e]));
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort();

  const movements: DerivationMovement[] = ids.map((id) => {
    const b = beforeById.get(id) ?? null;
    const a = afterById.get(id) ?? null;
    const changed = changedFields(b, a);
    return {
      transactionId: id,
      date: (a ?? b)!.date,
      partner: (a ?? b)!.partner,
      kind: movementKind(b, a, changed),
      before: b,
      after: a,
      changed,
      fileIds: [...new Set([...(b?.fileIds ?? []), ...(a?.fileIds ?? [])])],
      inputVatDelta: (a?.inputVat ?? 0) - (b?.inputVat ?? 0),
      outputVatDelta: (a?.outputVat ?? 0) - (b?.outputVat ?? 0),
    };
  });

  const totals = {
    inputVatBefore: before.totalInputVat,
    inputVatAfter: after.totalInputVat,
    inputVatDelta: after.totalInputVat - before.totalInputVat,
    outputVatBefore: before.totalOutputVat,
    outputVatAfter: after.totalOutputVat,
    outputVatDelta: after.totalOutputVat - before.totalOutputVat,
    balanceBefore: before.balance,
    balanceAfter: after.balance,
    balanceDelta: after.balance - before.balance,
  };

  const explainedInput = movements.reduce((s, m) => s + m.inputVatDelta, 0);
  const explainedOutput = movements.reduce((s, m) => s + m.outputVatDelta, 0);

  return {
    periodKey: after.periodKey,
    movements,
    totals,
    accountedFor:
      explainedInput === totals.inputVatDelta &&
      explainedOutput === totals.outputVatDelta,
    comparable: before.periodKey === after.periodKey,
  };
}

/** Movements worth a human's attention — everything that is not `unchanged`. */
export function movedEntries(rec: UvaReconciliation): DerivationMovement[] {
  return rec.movements.filter((m) => m.kind !== "unchanged");
}

/**
 * A movement whose source did not change but whose figure did. On a sweep this
 * is the regression bucket: the same rung read the same document and produced
 * a different number, so nothing about the change argues it is the better one.
 */
export function figureOnlyMovements(rec: UvaReconciliation): DerivationMovement[] {
  return rec.movements.filter((m) => m.kind === "figure-changed");
}

function changedFields(
  b: TransactionDerivationEntry | null,
  a: TransactionDerivationEntry | null
): MovementField[] {
  if (!b || !a) return [];
  const changed: MovementField[] = [];
  if (b.step !== a.step) changed.push("step");
  if (b.reason !== a.reason) changed.push("reason");
  if (!sameFiles(b.fileIds, a.fileIds)) changed.push("files");
  if (b.inputVat !== a.inputVat) changed.push("inputVat");
  if (b.outputVat !== a.outputVat) changed.push("outputVat");
  return changed;
}

function movementKind(
  b: TransactionDerivationEntry | null,
  a: TransactionDerivationEntry | null,
  changed: MovementField[]
): MovementKind {
  if (!b) return "appeared";
  if (!a) return "disappeared";
  if (changed.length === 0) return "unchanged";
  // Source outranks figure: when the rung or the documents moved, the new cents
  // are a consequence of that and not an independent event.
  return changed.some((f) => f === "step" || f === "reason" || f === "files")
    ? "source-changed"
    : "figure-changed";
}

function sameFiles(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}
