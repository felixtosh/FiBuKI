/**
 * UVA calculation that reads the receipts (fork #64).
 *
 * Pure module: plain transactions (with their connected files already
 * adapted) + period in, report out. Spec: homelab
 * work/finance/SPEC-uva-calculation.md, approved 2026-08-16.
 *
 * Derivation per transaction (spec §3):
 *   step 0  class gate (zero-VAT no-receipt categories)
 *   D3      foreign regimes (reverse charge / ig. Erwerb / import)
 *   step 1  connected files' line items, per-rate groups
 *   step 2  file top-level extraction
 *   step 3  manual vatRate override
 *   step 4  unresolved bucket — expenses claim ZERO (D1), income defaults
 *           to 20% flagged (understating output VAT is the worse error)
 */

import {
  KNOWN_AUSTRIAN_RATES,
  periodBoundaries,
  ratesValidInPeriod,
  ratesValidOn,
} from "./rateSet";
import { assessImpliedFx, isSameCurrency } from "../fx/fxPlausibility";
import type {
  DerivationStep,
  KennzahlFigure,
  RateGroup,
  UnresolvedReason,
  UvaCalculationInput,
  UvaFile,
  UvaReportResult,
  UvaTransaction,
} from "./types";

/** Bank-vs-invoice equality tolerance in cents — a product decision, not a legal bright line (spec §10.5). */
export const RECONCILE_TOLERANCE_CENTS = 2;
/** A restaurant overpay up to this fraction of the invoice total classifies as tip (R5) — product decision. */
const TIP_MAX_FRACTION = 0.1;
/** Tolerance in percentage points when matching an implied rate (vatAmount only) to the valid set. */
const IMPLIED_RATE_TOLERANCE = 0.5;

/** Output-side base Kennzahlen per rate (spec §4). Single source — legacyProjection imports this. */
export const OUTPUT_BASE_KZ: Record<number, string> = {
  20: "022",
  10: "029",
  13: "006",
  4.9: "124",
};

/** ig. Erwerb per-rate base Kennzahlen (spec §4). */
const EU_ACQUISITION_BASE_KZ: Record<number, string> = {
  20: "072",
  10: "073",
  13: "008",
  4.9: "125",
};

interface Derivation {
  ok: true;
  step: DerivationStep;
  /** Rate groups scaled to the claimed fraction. */
  groups: RateGroup[];
}

interface DerivationFailure {
  ok: false;
  reason: UnresolvedReason;
  /** Best-guess foregone VAT for the unresolved list, if any. */
  foregoneVat: number | null;
}

export function calculateUva(input: UvaCalculationInput): UvaReportResult {
  const { period } = input;
  const bounds = periodBoundaries(period);
  const transactions = input.transactions.filter(
    (t) => t.date >= bounds.start && t.date <= bounds.end
  );

  const kennzahlen: Record<string, KennzahlFigure> = {};
  const addKz = (code: string, cents: number, step: DerivationStep) => {
    const entry = (kennzahlen[code] ??= { value: 0, contributions: {} });
    entry.value += cents;
    entry.contributions[step] = (entry.contributions[step] ?? 0) + 1;
  };

  const outputByRate = new Map<number, { base: number; vat: number }>();
  let totalOutputVat = 0;
  let totalInputVat = 0;
  const result: UvaReportResult = {
    period: {
      ...period,
      ...bounds,
      timezone: "Europe/Vienna",
      rateSet: ratesValidInPeriod(period),
    },
    kennzahlen,
    outputVatByRate: [],
    totalOutputVat: 0,
    totalInputVat: 0,
    balance: 0,
    unresolved: [],
    foreignVat: [],
    reverseCharge: [],
    euKennzahlen: { basis: "not-implemented" },
  };

  const markUnresolved = (
    tx: UvaTransaction,
    reason: UnresolvedReason,
    foregoneVat: number | null,
    defaultedOutputVat?: number
  ) => {
    result.unresolved.push({
      transactionId: tx.id,
      date: tx.date,
      partner: tx.partnerName ?? null,
      amount: tx.amount,
      side: tx.amount > 0 ? "income" : "expense",
      reason,
      foregoneVat,
      ...(defaultedOutputVat !== undefined ? { defaultedOutputVat } : {}),
    });
  };

  for (const tx of transactions) {
    const isIncome = tx.amount > 0;
    const bank = Math.abs(tx.amount);

    // The report is in EUR; a bank line in another currency cannot feed a
    // Kennzahl in any lane (fork #87). Surface it rather than add raw cents.
    if (!isSameCurrency(tx.currency, "EUR")) {
      markUnresolved(tx, "foreign-currency", null);
      continue;
    }

    // --- D3: foreign regimes, each in its own bucket, never mixed --------
    if (tx.foreignRegime) {
      const regime = tx.foreignRegime;
      if (regime.kind === "service") {
        // Reverse charge §3a Abs 6 + §19 Abs 1 — EU and third country alike.
        // The bank amount IS the net (the supplier charged no VAT); the
        // self-assessed rate is the Austrian rate the service carries
        // domestically — standard 20% unless overridden (R8 pins the KZ
        // pair, not the rate).
        const rate = regime.domesticRate ?? 20;
        const vat = Math.round((bank * rate) / 100);
        addKz("057", vat, "reverse-charge");
        addKz("066", vat, "reverse-charge");
        totalOutputVat += vat;
        totalInputVat += vat;
        result.reverseCharge.push({
          transactionId: tx.id,
          base: bank,
          vat,
          origin: regime.origin,
          basis: regime.basis,
        });
      } else if (regime.origin === "eu") {
        // ig. Erwerb Art 1 BMR: Erwerbsteuer owed + deducted (KZ 065).
        const rate = regime.domesticRate ?? 20;
        const tax = Math.round((bank * rate) / 100);
        addKz("070", bank, "eu-acquisition");
        const baseKz = EU_ACQUISITION_BASE_KZ[rate];
        if (baseKz) addKz(baseKz, bank, "eu-acquisition");
        addKz("065", tax, "eu-acquisition");
        totalOutputVat += tax;
        totalInputVat += tax;
      } else {
        // Import: Einfuhrumsatzsteuer is deductible only when documented —
        // KZ 061 when paid, KZ 083 when deferred via §26 to the tax account.
        if (regime.importVatPaid != null && regime.importVatPaid > 0) {
          const kzCode = regime.importVatScheme === "deferred" ? "083" : "061";
          addKz(kzCode, regime.importVatPaid, "import");
          totalInputVat += regime.importVatPaid;
        } else {
          markUnresolved(tx, "no-vat-data", null);
        }
      }
      continue;
    }

    // --- Step 0: class gate ----------------------------------------------
    const treatment = tx.noReceiptCategory?.vatTreatment;
    if (treatment === "exempt-class" || treatment === "documented-elsewhere") {
      // Zero input VAT by construction (R9) / documented outside this report.
      continue;
    }
    if (treatment === "needs-receipt") {
      markUnresolved(tx, "needs-receipt", guessVat20(bank));
      continue;
    }

    // --- Steps 1-3: derive rate groups -----------------------------------
    const derivation = deriveRateGroups(tx, result);

    if (derivation.ok) {
      applyGroups(tx, derivation, isIncome);
      continue;
    }

    // --- Step 4: unresolved bucket (D1 asymmetry) -------------------------
    if (isIncome) {
      // Understating output VAT is the worse error: default 20%, flagged.
      const net = Math.round((bank * 100) / 120);
      const vat = bank - net;
      applyGroups(
        tx,
        { ok: true, step: "defaulted-20", groups: [{ rate: 20, net, vat, gross: bank }] },
        true
      );
      markUnresolved(tx, derivation.reason, null, vat);
    } else {
      markUnresolved(tx, derivation.reason, derivation.foregoneVat);
    }
  }

  result.totalOutputVat = totalOutputVat;
  result.totalInputVat = totalInputVat;
  result.balance = totalOutputVat - totalInputVat;
  // KZ095: single netted Zahllast/Gutschrift. KZ096 does not exist.
  kennzahlen["095"] = { value: result.balance, contributions: {} };
  result.outputVatByRate = [...outputByRate.entries()]
    .map(([rate, { base, vat }]) => ({ rate, base, vat }))
    .sort((a, b) => b.rate - a.rate);
  return result;

  // --- helpers bound to the accumulator state ----------------------------

  function applyGroups(tx: UvaTransaction, d: Derivation, income: boolean) {
    if (income) {
      // Aggregate per KZ before counting so one transaction contributes
      // one count per Kennzahl regardless of its group structure.
      const perKz = new Map<string, number>();
      let totalNet = 0;
      for (const g of d.groups) {
        totalNet += g.net;
        totalOutputVat += g.vat;
        const acc = outputByRate.get(g.rate) ?? { base: 0, vat: 0 };
        acc.base += g.net;
        acc.vat += g.vat;
        outputByRate.set(g.rate, acc);
        const code =
          g.rate === 0
            ? "011" // 0% without EU detection = export (EU KZs stay not-implemented)
            : OUTPUT_BASE_KZ[g.rate];
        if (code) perKz.set(code, (perKz.get(code) ?? 0) + g.net);
      }
      addKz("000", totalNet, d.step);
      for (const [code, cents] of perKz) addKz(code, cents, d.step);
    } else {
      let vat = 0;
      for (const g of d.groups) vat += g.vat;
      totalInputVat += vat;
      addKz("060", vat, d.step);
    }
  }
}

/** 20/120 of the bank gross — the foregone-VAT guess for the chasing worklist. */
function guessVat20(bank: number): number {
  return Math.round((bank * 20) / 120);
}

/**
 * Steps 1-3: derive per-rate groups from files (line items, then top-level),
 * then the manual override. Handles rate validation (R1 + the 19% ATU
 * enclave case), D2 foreign-VAT tagging, and bank-vs-invoice reconciliation
 * (R2/R5/R6) including partial payments and instalment caps.
 */
function deriveRateGroups(
  tx: UvaTransaction,
  result: UvaReportResult
): Derivation | DerivationFailure {
  const bank = Math.abs(tx.amount);
  const validRates = ratesValidOn(tx.date);

  // Income: the linked outgoing invoice carries real per-line rates and
  // resolves before any fallback (spec §3 step 4 note).
  if (tx.amount > 0 && tx.invoiceRateGroups?.length) {
    const invalid = tx.invoiceRateGroups.find(
      (g) => !validRates.includes(g.rate)
    );
    if (invalid) {
      return { ok: false, reason: "foreign-or-invalid-rate", foregoneVat: null };
    }
    return { ok: true, step: "invoice", groups: tx.invoiceRateGroups };
  }

  let files = tx.files ?? [];

  if (files.length > 0) {
    // Foreign-currency documents (fork #87): the document figures are in
    // another unit than the bank line, so they must never be read as-is.
    // With exactly one file the bank line IS the payment: bank / totalGross
    // is the effective rate actually paid on the payment date, and the whole
    // document is rescaled by it. Known limitation: § 20 Abs 6 UStG points
    // at the BMF monthly / ECB rate, and the card issuer's markup (1-3%) is
    // inside the effective rate, so the claim runs slightly high; without an
    // FX feed this is the best rate the data holds and the delta is
    // bounded by the plausibility band. Anything else — several files, no
    // total, an unknown currency, or an implied rate that is not a plausible
    // FX rate (a partial payment in disguise) — is surfaced instead of
    // guessed.
    const foreign = files.filter((f) => !isSameCurrency(f.currency, tx.currency));
    if (foreign.length > 0) {
      const converted = files.length === 1 ? convertToBankCurrency(files[0], tx) : null;
      if (!converted) {
        return { ok: false, reason: "foreign-currency", foregoneVat: guessVat20(bank) };
      }
      files = [converted];
    }

    // The extraction fix (§6) flags unreconciled line items instead of
    // destroying them — such a file is never trusted here. Since §6 item 3
    // a file can also carry the receipt's own printed per-rate VAT summary,
    // which is an independent (and §11-sufficient) reading of the document:
    // that block clears the file even when its line items are flagged.
    if (files.some((f) => f.lineItemsUnreconciled && !hasUsableRateGroups(f))) {
      return { ok: false, reason: "amount-mismatch", foregoneVat: guessVat20(bank) };
    }

    // Build per-file rate groups (step 1 falls through to step 2 per file).
    // Across files the reported step is the strongest one any file reached,
    // strongest first: printed rate groups, then line items, then top-level.
    const groups: RateGroup[] = [];
    let step: DerivationStep = "top-level";
    let sawVatData = false;
    for (const f of files) {
      const fileGroups = fileRateGroups(f, bank);
      if (fileGroups === null) continue; // no VAT data on this file
      sawVatData = true;
      if (fileGroups.step === "rate-groups") {
        step = "rate-groups";
      } else if (fileGroups.step === "line-items" && step !== "rate-groups") {
        step = "line-items";
      }
      for (const g of fileGroups.groups) {
        const rateOk =
          validRates.includes(g.rate) ||
          (g.rate === 19 && isAustrianUid(f.supplierVatId));
        if (!rateOk) {
          if (isForeignUid(f.supplierVatId)) {
            result.foreignVat.push({
              transactionId: tx.id,
              fileId: f.id,
              supplierVatId: f.supplierVatId ?? null,
              amount: tx.amount,
              rate: g.rate,
              refundCandidate: true,
            });
          }
          return {
            ok: false,
            reason: "foreign-or-invalid-rate",
            foregoneVat: g.vat || guessVat20(bank),
          };
        }
        groups.push(g);
      }
    }

    if (!sawVatData) {
      return { ok: false, reason: "no-vat-data", foregoneVat: guessVat20(bank) };
    }

    // Reconcile bank amount vs the SUM of the connected documents (R6).
    const invoiceTotal = files.reduce((s, f) => s + (f.totalGross ?? 0), 0);
    const prior = tx.priorClaimedFraction ?? 0;
    let fraction = 1;
    if (invoiceTotal > 0) {
      const delta = bank - invoiceTotal;
      if (Math.abs(delta) <= RECONCILE_TOLERANCE_CENTS) {
        fraction = 1;
      } else if (delta < 0) {
        // Partial payment: proportional claim (R2), capped so the file's
        // cumulative claimed fraction never exceeds 1 (instalments).
        fraction = Math.min(bank / invoiceTotal, 1 - prior);
      } else if (
        tx.partnerClass === "restaurant" &&
        delta <= invoiceTotal * TIP_MAX_FRACTION
      ) {
        // Tip delta (R5): outside VAT scope, claim from the invoice portion.
        fraction = 1;
      } else {
        return {
          ok: false,
          reason: "amount-mismatch",
          foregoneVat: guessVat20(bank),
        };
      }
    }

    if (fraction >= 1 && prior === 0) {
      return { ok: true, step, groups };
    }
    // Scale each group; rounding is anchored to the cumulative fraction so
    // instalments sum exactly to the document's VAT once fully paid.
    const scaled = groups.map((g) => ({
      rate: g.rate,
      net: scaleAnchored(g.net, prior, fraction),
      vat: scaleAnchored(g.vat, prior, fraction),
      gross: scaleAnchored(g.gross, prior, fraction),
    }));
    return { ok: true, step, groups: scaled };
  }

  // Step 3: manual override lane.
  if (tx.vatRateOverride != null) {
    const rate = tx.vatRateOverride;
    if (!validRates.includes(rate)) {
      return { ok: false, reason: "foreign-or-invalid-rate", foregoneVat: null };
    }
    const vat = Math.round((bank * rate) / (100 + rate));
    return {
      ok: true,
      step: "override",
      groups: [{ rate, net: bank - vat, vat, gross: bank }],
    };
  }

  return { ok: false, reason: "no-file", foregoneVat: guessVat20(bank) };
}

/**
 * Rescale a foreign-currency document into the bank line's currency at the
 * effective rate bank / totalGross. Returns null when no plausible rate can
 * be derived. Per group, vat and gross are rounded independently and net is
 * the difference, so net + vat === gross survives the conversion.
 */
function convertToBankCurrency(f: UvaFile, tx: UvaTransaction): UvaFile | null {
  const gross = f.totalGross ?? 0;
  if (gross <= 0) return null;
  const fx = assessImpliedFx(gross, f.currency, tx.amount, tx.currency);
  if (!fx.band || fx.impliedRate === null) return null;
  const r = fx.impliedRate;
  const cents = (c: number) => Math.round(c * r);
  return {
    ...f,
    currency: tx.currency ?? null,
    totalGross: cents(gross),
    vatAmount: f.vatAmount != null ? cents(f.vatAmount) : f.vatAmount,
    lineItems: f.lineItems
      ? f.lineItems.map((li) => ({ ...li, amount: cents(li.amount), vatAmount: cents(li.vatAmount) }))
      : f.lineItems,
    rateGroups: f.rateGroups
      ? f.rateGroups.map((g) => {
          const vat = cents(g.vat);
          const gr = cents(g.gross);
          return { rate: g.rate, vat, gross: gr, net: gr - vat };
        })
      : f.rateGroups,
  };
}

function scaleAnchored(cents: number, prior: number, fraction: number): number {
  return Math.round(cents * (prior + fraction)) - Math.round(cents * prior);
}

/**
 * Per-file rate groups: line items when usable (all rates known), otherwise
 * top-level extraction (Kleinbetragsrechnung math gross x r/(100+r), R4),
 * otherwise implied-rate from vatAmount alone. Null = no VAT data.
 */
/**
 * Does this file carry a printed per-rate VAT summary block we can use?
 * Validation already happened at extraction time (spec §6 item 3); here we
 * only guard against a legacy or hand-edited record carrying an empty array.
 */
function hasUsableRateGroups(f: UvaFile): boolean {
  return Array.isArray(f.rateGroups) && f.rateGroups.length > 0;
}

function fileRateGroups(
  f: UvaFile,
  bankFallbackGross: number
): { step: "rate-groups" | "line-items" | "top-level"; groups: RateGroup[] } | null {
  // Spec §6 item 3: the receipt's own VAT summary block outranks the line
  // items. It is one transcribed number per rate instead of a sum of N
  // itemised rows, so it survives the OCR noise that breaks itemisation —
  // and §11 makes the per-rate totals sufficient on their own.
  if (hasUsableRateGroups(f)) {
    return { step: "rate-groups", groups: (f.rateGroups as RateGroup[]).map((g) => ({ ...g })) };
  }

  const items = f.lineItems ?? [];
  if (items.length > 0 && items.every((li) => li.vatPercent != null)) {
    const byRate = new Map<number, RateGroup>();
    for (const li of items) {
      const rate = li.vatPercent as number;
      const g = byRate.get(rate) ?? { rate, net: 0, vat: 0, gross: 0 };
      g.gross += li.amount;
      g.vat += li.vatAmount;
      g.net += li.amount - li.vatAmount;
      byRate.set(rate, g);
    }
    return { step: "line-items", groups: [...byRate.values()] };
  }

  const gross = f.totalGross ?? bankFallbackGross;
  if (f.vatPercent != null) {
    const rate = f.vatPercent;
    const vat = f.vatAmount ?? Math.round((gross * rate) / (100 + rate));
    return {
      step: "top-level",
      groups: [{ rate, net: gross - vat, vat, gross }],
    };
  }
  if (f.vatAmount != null && gross > f.vatAmount) {
    const implied = (f.vatAmount / (gross - f.vatAmount)) * 100;
    // Snap to the nearest known rate; validation against the period set
    // happens in the caller. 19 included so DE-vs-ATU can be told apart.
    const candidates = KNOWN_AUSTRIAN_RATES;
    const rate = candidates.reduce((best, r) =>
      Math.abs(r - implied) < Math.abs(best - implied) ? r : best
    );
    if (Math.abs(rate - implied) > IMPLIED_RATE_TOLERANCE) {
      return {
        step: "top-level",
        groups: [{ rate: implied, net: gross - f.vatAmount, vat: f.vatAmount, gross }],
      };
    }
    return {
      step: "top-level",
      groups: [{ rate, net: gross - f.vatAmount, vat: f.vatAmount, gross }],
    };
  }
  return null;
}

function isAustrianUid(uid: string | null | undefined): boolean {
  return !!uid && uid.toUpperCase().startsWith("ATU");
}

function isForeignUid(uid: string | null | undefined): boolean {
  return !!uid && /^[A-Z]{2}/i.test(uid) && !isAustrianUid(uid);
}
