/**
 * Per-transaction VAT, for consumers that book one transaction at a time
 * (fork #66).
 *
 * `calculateUva` answers "what goes in each Kennzahl this period". A bookkeeping
 * export asks a narrower question — "what VAT does THIS line carry" — and used
 * to answer it with `tx.vatRate ?? 20`, which reads no receipts at all. Two
 * answers to the same question is how a BMD/DATEV trail and a filed UVA come to
 * disagree about the same transaction.
 *
 * So the derivation ladder itself is shared: this module runs the gates and then
 * delegates to `deriveRateGroups`, the exact function `calculateUva` uses. What
 * is intentionally NOT shared is the accumulation — Kennzahlen are a period
 * concept and have no meaning on a single booking row.
 *
 * Spec: homelab work/finance/SPEC-uva-calculation.md §3.
 */

import { deriveRateGroups } from "./calculateUva";
import { isSameCurrency } from "../fx/fxPlausibility";
import type {
  DerivationStep,
  ForeignVatEntry,
  RateGroup,
  UnresolvedReason,
  UvaTransaction,
} from "./types";

/**
 * Why a transaction carries no VAT on its booking line, distinct from failing
 * to work the VAT out. Both produce a zero, but only one of them is a gap.
 */
export type NoVatReason =
  /** Zero input VAT by law — bank fees, interest, wages, public charges (R9). */
  | "exempt-class"
  /** Accounted for outside this trail — transfers, private, PSP settlements. */
  | "documented-elsewhere"
  /**
   * Reverse charge §19: the supplier charged nothing, and the self-assessment
   * is its own posting rather than tax on this line.
   */
  | "reverse-charge"
  /** ig. Erwerb Art 1 BMR — Erwerbsteuer is likewise a separate posting. */
  | "eu-acquisition"
  /** Import: Einfuhrumsatzsteuer is settled with customs, not on this line. */
  | "import";

export type TransactionVat =
  | {
      kind: "groups";
      /** Which rung of the ladder produced this, for provenance. */
      step: DerivationStep;
      /** One entry per VAT rate found on the document. */
      groups: RateGroup[];
      foreignVat: ForeignVatEntry[];
    }
  | { kind: "no-vat"; why: NoVatReason }
  | {
      kind: "unresolved";
      reason: UnresolvedReason;
      /** Input VAT likely forgone, where a guess is possible (cents). */
      foregoneVat: number | null;
      foreignVat: ForeignVatEntry[];
    };

/**
 * Resolve one transaction's VAT.
 *
 * Order matches spec §3, and the order is load-bearing: the class gate runs
 * before the manual-override lane, so an Eigenbeleg ("receipt-lost",
 * needs-receipt) stays unresolved even when a rate was typed in. A self-issued
 * voucher never creates a deduction (D1), and letting an override rescue it
 * would put input VAT in the export that the UVA refuses to claim.
 */
export function deriveTransactionVat(tx: UvaTransaction): TransactionVat {
  // A bank line in another currency cannot be read as EUR cents anywhere
  // (fork #87). Surfaced, never guessed.
  if (!isSameCurrency(tx.currency, "EUR")) {
    return { kind: "unresolved", reason: "foreign-currency", foregoneVat: null, foreignVat: [] };
  }

  if (tx.foreignRegime) {
    const regime = tx.foreignRegime;
    if (regime.kind === "service") return { kind: "no-vat", why: "reverse-charge" };
    if (regime.origin === "eu") return { kind: "no-vat", why: "eu-acquisition" };
    return { kind: "no-vat", why: "import" };
  }

  const treatment = tx.noReceiptCategory?.vatTreatment;
  if (treatment === "exempt-class" || treatment === "documented-elsewhere") {
    return { kind: "no-vat", why: treatment };
  }
  if (treatment === "needs-receipt") {
    return {
      kind: "unresolved",
      reason: "needs-receipt",
      foregoneVat: Math.round((Math.abs(tx.amount) * 20) / 120),
      foreignVat: [],
    };
  }

  const derivation = deriveRateGroups(tx);
  if (derivation.ok) {
    return {
      kind: "groups",
      step: derivation.step,
      groups: derivation.groups,
      foreignVat: derivation.foreignVat,
    };
  }

  // Income keeps the D1 asymmetry that calculateUva applies: understating
  // output VAT is the worse error, so an undocumented sale still books 20%.
  // An undocumented purchase claims nothing.
  if (tx.amount > 0) {
    const bank = tx.amount;
    const net = Math.round((bank * 100) / 120);
    return {
      kind: "groups",
      step: "defaulted-20",
      groups: [{ rate: 20, net, vat: bank - net, gross: bank }],
      foreignVat: derivation.foreignVat,
    };
  }

  return {
    kind: "unresolved",
    reason: derivation.reason,
    foregoneVat: derivation.foregoneVat,
    foreignVat: derivation.foreignVat,
  };
}

/** Total VAT across the resolved groups, cents. Zero for every other outcome. */
export function totalVatOf(v: TransactionVat): number {
  return v.kind === "groups" ? v.groups.reduce((s, g) => s + g.vat, 0) : 0;
}
