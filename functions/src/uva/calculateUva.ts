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
import { assessTip, documentsTotalWithTip, isTipPartialPayment } from "./tip";
import { assessImpliedFx, isSameCurrency } from "../fx/fxPlausibility";
import { ecbCrossRate, type EcbRateTable } from "../fx/ecbRates";
import { singleDocumentRate } from "../extraction/lineItemReconciliation";
import { bookingSide, correctionAmounts } from "./correction";
import type {
  DerivationStep,
  ForeignVatEntry,
  FxConversionEntry,
  FxRateMethod,
  FxRateReason,
  KennzahlFigure,
  NonClaimableVatEntry,
  RateGroup,
  UnresolvedReason,
  UvaCalculationInput,
  UvaCorrection,
  UvaFile,
  UvaReportResult,
  UvaTransaction,
} from "./types";

/** Bank-vs-invoice equality tolerance in cents — a product decision, not a legal bright line (spec §10.5). */
export const RECONCILE_TOLERANCE_CENTS = 2;
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

export interface Derivation {
  ok: true;
  step: DerivationStep;
  /** Rate groups scaled to the claimed fraction. */
  groups: RateGroup[];
  /** D2 foreign-VAT sightings made while deriving. Usually empty. */
  foreignVat: ForeignVatEntry[];
  /** Documents whose VAT was excluded as non-claimable (#203). Usually empty. */
  nonClaimableVat: NonClaimableVatEntry[];
  /** Foreign-currency documents read at the effective rate paid. Usually empty. */
  fxConversions: FxConversionEntry[];
  /**
   * The Trinkgeld this payment carries, in the bank's currency, scaled on the
   * same anchor as `groups` (#554). Set by the file ladder only; outside the
   * VAT base, so it reaches no Kennzahl. The BMD export books it as the 0% row.
   */
  tip?: number;
  /**
   * The groups were scaled as a partial payment of a tipped bill because a
   * live Accepted Partial Payment ruling said the shortfall is real (#554).
   */
  partialPaymentAccepted?: true;
}

export interface DerivationFailure {
  ok: false;
  reason: UnresolvedReason;
  /** Best-guess foregone VAT for the unresolved list, if any. */
  foregoneVat: number | null;
  /** D2 foreign-VAT sightings made while deriving. Usually empty. */
  foreignVat: ForeignVatEntry[];
  /** Documents whose VAT was excluded as non-claimable (#203). Usually empty. */
  nonClaimableVat: NonClaimableVatEntry[];
  /** Foreign-currency documents read at the effective rate paid. Usually empty. */
  fxConversions: FxConversionEntry[];
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
    derivations: [],
    fxConversions: [],
    nonClaimableVat: [],
    foreignVat: [],
    reverseCharge: [],
    corrections: [],
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

  /**
   * One line in the per-transaction record the Kennzahlen were summed from
   * (#85). Every transaction the loop touches gets exactly one, including the
   * ones that book nothing — an entry that books zero because its class is
   * exempt is a different fact from one that books zero because no receipt
   * turned up, and the reconciliation has to be able to tell them apart.
   */
  const recordDerivation = (
    tx: UvaTransaction,
    e: {
      step: DerivationStep | null;
      reason?: UnresolvedReason | null;
      outputVat?: number;
      inputVat?: number;
      partialPaymentAccepted?: true;
      /** Documents the figure rests on beyond the line's own (a correction's original). */
      extraFileIds?: string[];
    }
  ) => {
    const fileIds = (tx.files ?? []).map((f) => f.id);
    for (const id of e.extraFileIds ?? []) if (!fileIds.includes(id)) fileIds.push(id);
    result.derivations.push({
      transactionId: tx.id,
      date: tx.date,
      partner: tx.partnerName ?? null,
      amount: tx.amount,
      side: tx.amount > 0 ? "income" : "expense",
      step: e.step,
      reason: e.reason ?? null,
      fileIds,
      outputVat: e.outputVat ?? 0,
      inputVat: e.inputVat ?? 0,
      ...(e.partialPaymentAccepted ? { partialPaymentAccepted: true as const } : {}),
    });
  };

  for (const tx of transactions) {
    const isIncome = tx.amount > 0;
    const bank = Math.abs(tx.amount);

    // The report is in EUR; a bank line in another currency cannot feed a
    // Kennzahl in any lane (fork #87). Surface it rather than add raw cents.
    if (!isSameCurrency(tx.currency, "EUR")) {
      markUnresolved(tx, "foreign-currency", null);
      recordDerivation(tx, { step: null, reason: "foreign-currency" });
      continue;
    }

    // --- Corrections (#564, ADR-0010) ------------------------------------
    // A refund reverses what its original did, on the original's side, and
    // nothing the line's own documents print decides the figure. An unlinked
    // one keeps the safe default — money in is 20% revenue, money out claims
    // nothing — and blocks the filing until it is linked or reclassified.
    if (tx.correction?.status === "linked") {
      applyCorrection(tx, tx.correction, bank);
      continue;
    }
    if (tx.correction?.status === "unlinked") {
      recordCorrection(tx, tx.correction, null);
      if (isIncome) defaultIncomeAt20(tx, bank, "correction-unlinked");
      else {
        markUnresolved(tx, "correction-unlinked", null);
        recordDerivation(tx, { step: null, reason: "correction-unlinked" });
      }
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
        recordDerivation(tx, {
          step: "reverse-charge",
          outputVat: vat,
          inputVat: vat,
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
        recordDerivation(tx, {
          step: "eu-acquisition",
          outputVat: tax,
          inputVat: tax,
        });
      } else {
        // Import: Einfuhrumsatzsteuer is deductible only when documented —
        // KZ 061 when paid, KZ 083 when deferred via §26 to the tax account.
        if (regime.importVatPaid != null && regime.importVatPaid > 0) {
          const kzCode = regime.importVatScheme === "deferred" ? "083" : "061";
          addKz(kzCode, regime.importVatPaid, "import");
          totalInputVat += regime.importVatPaid;
          recordDerivation(tx, {
            step: "import",
            inputVat: regime.importVatPaid,
          });
        } else {
          markUnresolved(tx, "no-vat-data", null);
          recordDerivation(tx, { step: null, reason: "no-vat-data" });
        }
      }
      continue;
    }

    // --- Step 0: class gate ----------------------------------------------
    const treatment = tx.noReceiptCategory?.vatTreatment;
    if (treatment === "exempt-class" || treatment === "documented-elsewhere") {
      // Zero input VAT by construction (R9) / documented outside this report.
      recordDerivation(tx, { step: treatment });
      continue;
    }
    if (treatment === "needs-receipt") {
      // The gate is direction-aware (fork #129). An Eigenbeleg is a self-issued
      // voucher, so an EXPENSE claims no Vorsteuer (R9) and only earns a place
      // on the chasing list. INCOME is the understating direction: a sale whose
      // receipt was lost still owes output VAT, so it takes the same defaulted
      // lane step 4 uses instead of dropping out of the report entirely.
      if (isIncome) defaultIncomeAt20(tx, bank, "needs-receipt");
      else {
        markUnresolved(tx, "needs-receipt", guessVat20(bank));
        recordDerivation(tx, { step: null, reason: "needs-receipt" });
      }
      continue;
    }

    // --- Steps 1-3: derive rate groups -----------------------------------
    // The ladder is pure and shared — the BMD export runs the same one, so the
    // two trails cannot disagree about a transaction's VAT (fork #66).
    const derivation = deriveRateGroups(tx, input.ecbRates ?? null);
    result.foreignVat.push(...derivation.foreignVat);
    result.nonClaimableVat.push(...derivation.nonClaimableVat);

    if (derivation.ok) {
      // A conversion is reported only when it was USED. A document converted
      // on the way to a derivation that then failed had no rate applied to
      // anything, and listing it would put a file in the filing's exception
      // with no cents behind it.
      result.fxConversions.push(...derivation.fxConversions);
      applyGroups(tx, derivation, isIncome, null);
      continue;
    }

    // --- Step 4: unresolved bucket (D1 asymmetry) -------------------------
    if (isIncome) {
      defaultIncomeAt20(tx, bank, derivation.reason);
    } else {
      markUnresolved(tx, derivation.reason, derivation.foregoneVat);
      recordDerivation(tx, { step: null, reason: derivation.reason });
    }
  }

  floorNegativeOutputBases();

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

  /**
   * A linked correction (#564). A purchase refund reverses the Vorsteuer its
   * original claimed, signed, in KZ 067 — KZ 060 keeps only this period's
   * claims and revenue is untouched. The User's own refund reverses the tax
   * its sale owed: negative into KZ 000 and the rate field, floored at the end
   * of the period with the overflow in KZ 090.
   */
  function applyCorrection(
    tx: UvaTransaction,
    c: Extract<UvaCorrection, { status: "linked" }>,
    bank: number
  ) {
    const amounts = correctionAmounts(bank, c.original.claimed, c.original.gross, c.priorCorrected);
    recordCorrection(tx, c, amounts);
    const vat = amounts.groups.reduce((s, g) => s + g.vat, 0);
    if (bookingSide(tx) === "purchase-correction") {
      if (vat !== 0) addKz("067", -vat, "purchase-correction");
      totalInputVat -= vat;
      recordDerivation(tx, {
        step: "purchase-correction",
        inputVat: -vat,
        extraFileIds: [c.original.fileId],
      });
      return;
    }
    const perKz = new Map<string, number>();
    let totalNet = 0;
    for (const g of amounts.groups) {
      totalNet += g.net;
      totalOutputVat -= g.vat;
      const acc = outputByRate.get(g.rate) ?? { base: 0, vat: 0 };
      acc.base -= g.net;
      acc.vat -= g.vat;
      outputByRate.set(g.rate, acc);
      const code = OUTPUT_BASE_KZ[g.rate];
      if (code) perKz.set(code, (perKz.get(code) ?? 0) + g.net);
    }
    if (totalNet !== 0) addKz("000", -totalNet, "sale-correction");
    for (const [code, cents] of perKz) addKz(code, -cents, "sale-correction");
    recordDerivation(tx, {
      step: "sale-correction",
      outputVat: -vat,
      extraFileIds: [c.original.fileId],
    });
  }

  function recordCorrection(
    tx: UvaTransaction,
    c: UvaCorrection,
    amounts: ReturnType<typeof correctionAmounts> | null
  ) {
    const linked = c.status === "linked" ? c : null;
    const printedVat = linked?.printedVat ?? null;
    result.corrections.push({
      transactionId: tx.id,
      date: tx.date,
      partner: tx.partnerName ?? null,
      amount: tx.amount,
      side: linked
        ? linked.kind === "purchase"
          ? "purchase-correction"
          : "sale-correction"
        : tx.amount > 0
          ? "purchase-correction"
          : "sale-correction",
      status: c.status,
      basis: linked?.basis ?? null,
      unlinkedReason: c.status === "unlinked" ? c.reason : null,
      fileIds:
        c.status === "unlinked"
          ? c.fileIds
          : c.correctionFileId
            ? [c.correctionFileId]
            : [],
      originalFileId: linked?.original.fileId ?? (c.status === "unlinked" ? c.originalFileId ?? null : null),
      paidByTransactionIds: linked?.original.paidByTransactionIds ?? [],
      originalGross: linked?.original.gross ?? 0,
      claimed: linked?.original.claimed ?? [],
      priorCorrected: linked?.priorCorrected ?? [],
      corrected: amounts?.groups ?? [],
      excessVat: amounts?.excessVat ?? 0,
      printedVat,
      printedVatMismatch:
        printedVat !== null &&
        amounts !== null &&
        Math.abs(printedVat - amounts.uncappedVat) > RECONCILE_TOLERANCE_CENTS,
    });
  }

  /**
   * Only KZ 063, 067 and 090 carry a sign on the U30. A rate field the
   * period's sale corrections took below zero shows 0, and its (negative) tax
   * goes to KZ 090 — the BMF's worked example for Entgeltsänderungen. KZ 000
   * gives back the same base, and is floored the same way. The balance is
   * untouched: the tax only moves between Kennzahlen.
   */
  function floorNegativeOutputBases() {
    let floored = 0;
    for (const [rate, acc] of outputByRate) {
      const code = rate === 0 ? "011" : OUTPUT_BASE_KZ[rate];
      const kz = code ? kennzahlen[code] : undefined;
      if (!kz || kz.value >= 0) continue;
      floored -= kz.value;
      kz.value = 0;
      addKz("090", acc.vat, "sale-correction");
    }
    const total = kennzahlen["000"];
    if (total && (floored > 0 || total.value < 0)) {
      total.value = Math.max(total.value + floored, 0);
    }
  }

  /**
   * The D1 asymmetry: income whose VAT cannot be derived still books 20%,
   * flagged in the unresolved bucket, because understating output VAT is the
   * worse error. `foregoneVat` stays null — it names input VAT the operator
   * could still recover with a receipt, which is not what an unremitted output
   * liability is.
   */
  function defaultIncomeAt20(
    tx: UvaTransaction,
    bank: number,
    reason: UnresolvedReason
  ) {
    const net = Math.round((bank * 100) / 120);
    const vat = bank - net;
    applyGroups(
      tx,
      {
        ok: true,
        step: "defaulted-20",
        groups: [{ rate: 20, net, vat, gross: bank }],
        foreignVat: [],
        nonClaimableVat: [],
        fxConversions: [],
      },
      true,
      reason
    );
    markUnresolved(tx, reason, null, vat);
  }

  function applyGroups(
    tx: UvaTransaction,
    d: Derivation,
    income: boolean,
    reason: UnresolvedReason | null
  ) {
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
      recordDerivation(tx, {
        step: d.step,
        reason,
        outputVat: d.groups.reduce((s, g) => s + g.vat, 0),
        partialPaymentAccepted: d.partialPaymentAccepted,
      });
    } else {
      let vat = 0;
      for (const g of d.groups) vat += g.vat;
      totalInputVat += vat;
      addKz("060", vat, d.step);
      recordDerivation(tx, {
        step: d.step,
        reason,
        inputVat: vat,
        partialPaymentAccepted: d.partialPaymentAccepted,
      });
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
 * (R2/R6) including partial payments and instalment caps.
 */
export function deriveRateGroups(
  tx: UvaTransaction,
  ecbRates?: EcbRateTable | null
): Derivation | DerivationFailure {
  const bank = Math.abs(tx.amount);
  const validRates = ratesValidOn(tx.date);
  const foreignVat: ForeignVatEntry[] = [];
  const nonClaimableVat: NonClaimableVatEntry[] = [];
  const fxConversions: FxConversionEntry[] = [];
  const isIncome = tx.amount > 0;
  /**
   * A file a human marked non-claimable (#203), on an expense. Nothing it
   * prints is claimed, so the guards that refuse a transaction on the strength
   * of what a file prints must not read it either — see the call sites below.
   */
  const isExcluded = (f: UvaFile) => !isIncome && f.nonClaimableVatReason != null;

  // Income: the linked outgoing invoice carries real per-line rates and
  // resolves before any fallback (spec §3 step 4 note).
  if (tx.amount > 0 && tx.invoiceRateGroups?.length) {
    const invalid = tx.invoiceRateGroups.find(
      (g) => !validRates.includes(g.rate)
    );
    if (invalid) {
      return { ok: false, reason: "foreign-or-invalid-rate", foregoneVat: null, foreignVat, nonClaimableVat, fxConversions };
    }
    return { ok: true, step: "invoice", groups: tx.invoiceRateGroups, foreignVat, nonClaimableVat, fxConversions };
  }

  let files = tx.files ?? [];
  /**
   * R6 total to reconcile the bank line against, when it is not the sum of
   * the converted documents (#92). See the conversion block below.
   */
  let reconcileTotal: number | null = null;

  if (files.length > 0) {
    // Foreign-currency documents (fork #87): the document figures are in
    // another unit than the bank line, so they must never be read as-is.
    // With exactly one file the bank line IS the payment, and the document is
    // rescaled into the bank's currency.
    //
    // WHICH rate does the rescaling is § 20 Abs 6 UStG's question, and since
    // #92 it prefers method 2 — the last rate the ECB published on or before
    // the payment date — over method 3, the effective rate the card charged
    // (bank / totalGross). Both are permitted; the effective rate carries the
    // issuer's 1-3% markup inside it and so claims slightly more input VAT
    // than the supply actually bore. Method 3 remains the fallback for a date
    // or a currency the feed does not reach, which is what every run did
    // before the feed existed.
    //
    // Anything else — several files, no total, an unknown currency, or an
    // implied rate that is not a plausible FX rate (a partial payment in
    // disguise) — is surfaced instead of guessed.
    const inBank = documentsInBankCurrency(tx, ecbRates);
    if (!inBank) {
      return { ok: false, reason: "foreign-currency", foregoneVat: guessVat20(bank), foreignVat, nonClaimableVat, fxConversions };
    }
    const converted = inBank.conversion;
    if (converted) {
      fxConversions.push(converted);
      files = inBank.files;
      // R6 compares the bank line against the document total, and at a
      // published rate those two no longer agree: the residual IS the markup
      // the method exists to strip. Read as a payment difference it would be
      // an over- or under-payment — a 20.86 document paid with 21.28 reads as
      // amount-mismatch, and the whole claim would be refused for being MORE
      // correct. So the converted document reconciles against the payment
      // itself; whether the bank line really is the whole payment was already
      // decided, in the document's own currency, by the plausibility gate.
      reconcileTotal = converted.bankAmount;
    }

    // The extraction fix (§6) flags unreconciled line items instead of
    // destroying them — such a file is never trusted here. Since §6 item 3
    // a file can also carry the receipt's own printed per-rate VAT summary,
    // which is an independent (and §11-sufficient) reading of the document:
    // that block clears the file even when its line items are flagged.
    // A file marked non-claimable is exempt: the flag says its printed figures
    // are not trustworthy enough to CLAIM from, and this file claims nothing.
    // Refusing the transaction over it would put its VAT back on the chasing
    // list as recoverable, which is the reading the marker exists to remove.
    // #511: neither does a single-rate document. Its VAT is its total at its
    // one rate, which the top-level rung derives without the broken rows.
    if (
      files.some(
        (f) =>
          !isExcluded(f) &&
          f.lineItemsUnreconciled &&
          !hasUsableRateGroups(f) &&
          !isSingleRateDocument(f)
      )
    ) {
      return { ok: false, reason: "amount-mismatch", foregoneVat: guessVat20(bank), foreignVat, nonClaimableVat, fxConversions };
    }

    // Build per-file rate groups (step 1 falls through to step 2 per file).
    // Across files the reported step is the strongest one any file reached,
    // strongest first: printed rate groups, then line items, then top-level.
    const groups: RateGroup[] = [];
    let step: DerivationStep = "top-level";
    let sawVatData = false;
    let sawClaimableGroups = false;
    for (const f of files) {
      const fileGroups = fileRateGroups(f, bank);

      // #203: a human recorded that this document's VAT is not deductible.
      // The figure is real — it is on the paper — so the document's GROSS
      // still books, at zero rate, and the excluded VAT is reported rather
      // than dropped. Nothing below runs for such a file: rate validation is
      // what would reject a Versicherungssteuer document as an invalid rate
      // and put its 22.00 EUR on the chasing list as recoverable, which is
      // the opposite of what the marker says.
      //
      // Expenses only. The marker names input VAT that must not be deducted;
      // applied to income it would zero an output liability instead, which is
      // the understating direction the whole module is built to avoid (D1).
      const excludedReason = isExcluded(f) ? f.nonClaimableVatReason ?? null : null;
      if (excludedReason) {
        sawVatData = true;
        let excludedVat = 0;
        for (const g of fileGroups?.groups ?? []) {
          excludedVat += g.vat;
          groups.push({ rate: 0, net: g.gross, vat: 0, gross: g.gross });
        }
        if (!fileGroups && f.totalGross) {
          groups.push({ rate: 0, net: f.totalGross, vat: 0, gross: f.totalGross });
        }
        nonClaimableVat.push({
          transactionId: tx.id,
          fileId: f.id,
          reason: excludedReason,
          excludedVat,
        });
        continue;
      }

      if (fileGroups === null) continue; // no VAT data on this file
      sawVatData = true;
      sawClaimableGroups = true;
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
            foreignVat.push({
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
            foreignVat,
            nonClaimableVat,
            fxConversions,
          };
        }
        groups.push(g);
      }
    }

    // The step names the rung that produced the claim. When every file that
    // carried VAT was excluded, no rung did — say so, so the exclusion shows
    // up in the Kennzahl's contributions instead of masquerading as a
    // top-level reading that happened to come out at zero.
    if (nonClaimableVat.length > 0 && !sawClaimableGroups) {
      step = "non-claimable";
    }

    if (!sawVatData) {
      return { ok: false, reason: "no-vat-data", foregoneVat: guessVat20(bank), foreignVat, nonClaimableVat, fxConversions };
    }

    // A tip that is not smaller than the bank line is not a tip (#317). It
    // must be judged BEFORE it joins the reconcile total below, because there
    // it is indistinguishable from an invoice the bank line only partly paid:
    // the delta goes negative, the partial-payment branch scales the
    // document's rates by bank/invoiceTotal, and a 54,00 charge carrying a
    // 54,00 tip claims 2,86 of Vorsteuer off a figure nobody can support. The
    // BMD export refuses the same transaction, on this same predicate (#194).
    // Claim nothing and put it on the review list; the fix is to correct the
    // Trinkgeld on the document (#217) and re-run.
    const tipHere = assessTip(files, bank);
    if (tipHere.impossible) {
      return {
        ok: false,
        reason: "impossible-tip",
        // What the correction is worth chasing, on the same 20% proxy the
        // amount-mismatch branch this diverts from uses. The document's own
        // VAT is not that figure: the tip is wrong, so the split between
        // Summe and Trinkgeld it rests on is unknown until someone fixes it.
        foregoneVat: guessVat20(bank),
        foreignVat,
        nonClaimableVat,
        fxConversions,
      };
    }

    // Reconcile bank amount vs the SUM of the connected documents (R6).
    // A Trinkgeld is part of what the card was charged and no part of the VAT
    // base — transcribed where the Beleg prints it (#172), hand-set where it
    // does not (#217) — so it joins the total here and nowhere else: the
    // reconcile comes out exact and no tolerance rung is involved.
    const invoiceTotal = reconcileTotal ?? documentsTotalWithTip(files);

    // A possible tip the bank line still falls short of (#554). Below, the
    // shortfall would take R2 and claim `bank / (document + tip)` of the
    // document's VAT — and a 100,00 Beleg whose 10,00 tip was typed as 100,00
    // claims 9,17 of its 16,67 with nothing on the review list. A split bill
    // looks exactly the same and SHOULD be claimed in part, so arithmetic does
    // not decide: the line claims nothing and waits on review until the tip is
    // corrected or a person records an Accepted Partial Payment. The BMD
    // export refuses the same transaction, on this same predicate.
    const tipShort = isTipPartialPayment(tipHere, bank, invoiceTotal, RECONCILE_TOLERANCE_CENTS);
    if (tipShort && !tx.partialPaymentAccepted) {
      return {
        ok: false,
        reason: "tip-partial-payment",
        // The same 20% proxy `impossible-tip` uses: which part of the document
        // is claimable is the question the ruling has not answered yet.
        foregoneVat: guessVat20(bank),
        foreignVat,
        nonClaimableVat,
        fxConversions,
      };
    }
    const accepted = tipShort ? { partialPaymentAccepted: true as const } : {};

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
      } else {
        // An overpay the connected documents do not account for. R5 used to
        // classify a small one at a restaurant-class partner as a tip and
        // claim the full invoice portion, but nothing ever wrote partnerClass
        // — it read like coverage and provided none (#172). A tip is now its
        // own extracted figure, already inside invoiceTotal above, whether the
        // Beleg printed it or a person recorded the one it never printed
        // (#217). A delta nobody has explained still goes to the review
        // bucket: a person says a tip was taken, this arithmetic never does.
        return {
          ok: false,
          reason: "amount-mismatch",
          foregoneVat: guessVat20(bank),
          foreignVat,
          nonClaimableVat,
          fxConversions,
        };
      }
    }

    if (fraction >= 1 && prior === 0) {
      return { ok: true, step, groups, foreignVat, nonClaimableVat, fxConversions, tip: tipHere.tip };
    }
    // Scale each group; rounding is anchored to the cumulative fraction so
    // instalments sum exactly to the document's VAT once fully paid.
    const scaled = groups.map((g) => ({
      rate: g.rate,
      net: scaleAnchored(g.net, prior, fraction),
      vat: scaleAnchored(g.vat, prior, fraction),
      gross: scaleAnchored(g.gross, prior, fraction),
    }));
    // The excluded figure is scaled on the same anchor as the groups it sits
    // beside. An instalment that could only ever have claimed half the
    // document's VAT did not exclude the whole of it, and two instalments
    // must not each report the full amount.
    const scaledNonClaimable = nonClaimableVat.map((n) => ({
      ...n,
      excludedVat: scaleAnchored(n.excludedVat, prior, fraction),
    }));
    return {
      ok: true,
      step,
      groups: scaled,
      foreignVat,
      nonClaimableVat: scaledNonClaimable,
      fxConversions,
      // The tip is part of what was paid, so a payment of half the bill paid
      // half the tip too: a split bill of 100,00 + 10,00 paid with 55,00
      // carries 5,00 of it, not 10,00 (#554).
      tip: scaleAnchored(tipHere.tip, prior, fraction),
      ...accepted,
    };
  }

  // Step 3: manual override lane.
  if (tx.vatRateOverride != null) {
    const rate = tx.vatRateOverride;
    if (!validRates.includes(rate)) {
      return { ok: false, reason: "foreign-or-invalid-rate", foregoneVat: null, foreignVat, nonClaimableVat, fxConversions };
    }
    const vat = Math.round((bank * rate) / (100 + rate));
    return {
      ok: true,
      step: "override",
      groups: [{ rate, net: bank - vat, vat, gross: bank }],
      foreignVat,
      nonClaimableVat,
      fxConversions,
    };
  }

  return { ok: false, reason: "no-file", foregoneVat: guessVat20(bank), foreignVat, nonClaimableVat, fxConversions };
}

/**
 * Rescale a foreign-currency document into the bank line's currency
 * (§ 20 Abs 6 UStG). Returns null when no plausible rate can be derived. Per
 * group, vat and gross are rounded independently and net is the difference,
 * so net + vat === gross survives the conversion.
 *
 * Two rates are in play and both end up on the record (#92):
 *
 *  - the EFFECTIVE rate, bank / totalGross. It is what the payment actually
 *    carried, and it is what the plausibility gate judges — an implausible
 *    one means this bank line is not the whole payment for this document, and
 *    then no rate at all should be applied to it.
 *  - the APPLIED rate, which is the ECB's published rate for the payment date
 *    when the feed reaches it (method 2) and otherwise the effective rate
 *    (method 3).
 *
 * The gate stays on the effective rate deliberately. Preferring the ECB rate
 * changes which figure is booked; it must not change which documents are
 * trusted enough to book at all.
 */
function convertToBankCurrency(
  f: UvaFile,
  tx: UvaTransaction,
  ecbRates?: EcbRateTable | null,
  isIncome = false
): { file: UvaFile; conversion: FxConversionEntry } | null {
  const gross = f.totalGross ?? 0;
  if (gross <= 0) return null;

  // The published rate doubles as the plausibility anchor for this date. The
  // static anchors in fxPlausibility are current-era, so on an older payment
  // they judge the pair against a rate the day never carried (the 2022 USD
  // parity case); where the feed reaches the date, it is simply the better
  // anchor and the same number the conversion is about to use.
  const published = ecbRates
    ? ecbCrossRate(ecbRates, f.currency, tx.currency, tx.date)
    : null;
  const fx = assessImpliedFx(gross, f.currency, tx.amount, tx.currency, {
    referenceRate: published?.rate ?? null,
  });
  if (!fx.band || fx.impliedRate === null) return null;

  const effective = fx.impliedRate;
  // Method 2 is preferred on the DEDUCTION side, where the issuer's markup
  // inside the effective rate claims more input VAT than the supply bore.
  // Income is the other direction: under Ist-Besteuerung the Entgelt is the
  // money that actually arrived, so the bank's own EUR figure IS the base.
  // Converting it at a published rate would declare a turnover nobody
  // received, and a published rate below the effective one would understate
  // the liability — the direction this module refuses everywhere else.
  const usePublished = published !== null && !isIncome;
  const r = usePublished ? published.rate : effective;
  const method: FxRateMethod = usePublished ? "ecb-reference" : "effective-bank-rate";
  const reason: FxRateReason = usePublished
    ? "ecb-published"
    : isIncome
      ? "income-cash-basis"
      : ecbRates
        ? "no-ecb-rate"
        : "no-ecb-table";
  const cents = (c: number) => Math.round(c * r);
  const conversion: FxConversionEntry = {
    transactionId: tx.id,
    fileId: f.id,
    documentCurrency: f.currency ?? "EUR",
    documentGross: gross,
    documentVat: documentVatOf(f),
    bankAmount: Math.abs(tx.amount),
    impliedRate: effective,
    appliedRate: r,
    method,
    reason,
    rateDate: usePublished ? published.rateDate : null,
    band: fx.band,
  };
  const file: UvaFile = {
    ...f,
    currency: tx.currency ?? null,
    totalGross: cents(gross),
    tipAmount: f.tipAmount != null ? cents(f.tipAmount) : f.tipAmount,
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
  return { file, conversion };
}

/**
 * A transaction's documents in the bank line's currency, or null when they
 * cannot be put there (#326).
 *
 * The rule the ladder above applies before it reads a single figure, lifted
 * out so the BMD export reads a document's tip in the same unit the UVA does.
 * Before, the export judged a USD tip in dollars against a euro bank line
 * while the UVA judged the converted figure, and the two could reach opposite
 * verdicts on one transaction.
 *
 * Documents already in the bank's currency come back as they are, with no
 * conversion. A single foreign document is converted (`convertToBankCurrency`,
 * ECB rate preferred). Anything else foreign — several files, no total, an
 * implausible implied rate — is null: there is no figure in the bank's unit to
 * judge, and the ladder surfaces it as `foreign-currency`.
 */
export function documentsInBankCurrency(
  tx: UvaTransaction,
  ecbRates?: EcbRateTable | null
): { files: UvaFile[]; conversion: FxConversionEntry | null } | null {
  const files = tx.files ?? [];
  if (files.every((f) => isSameCurrency(f.currency, tx.currency))) {
    return { files, conversion: null };
  }
  const converted =
    files.length === 1
      ? convertToBankCurrency(files[0], tx, ecbRates, tx.amount > 0)
      : null;
  return converted ? { files: [converted.file], conversion: converted.conversion } : null;
}

/**
 * The document's own VAT, in its own currency (#92). Follows the derivation's
 * own preference order — printed rate groups, then line items, then the
 * top-level figure — so the delta between the two rates is measured on the
 * same cents the claim is built from.
 */
function documentVatOf(f: UvaFile): number {
  // Through the derivation's own predicates, not a parallel copy of them, so
  // the delta is measured on the cents the claim was built from. The line-item
  // rung needs every item to state a rate; a partial set falls through to the
  // top-level figure, and summing it here would report a movement against
  // cents that never reached a Kennzahl.
  if (hasUsableRateGroups(f)) {
    return (f.rateGroups as RateGroup[]).reduce((s, g) => s + g.vat, 0);
  }
  if (lineItemsUsable(f)) {
    return (f.lineItems ?? []).reduce((s, li) => s + li.vatAmount, 0);
  }
  return f.vatAmount ?? 0;
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

/**
 * The line-item rung: every row states a rate, and the rows reconciled. A
 * flagged file only reaches derivation at all when it is single-rate (#511),
 * and then its rows are skipped for the top-level figure.
 */
function lineItemsUsable(f: UvaFile): boolean {
  const items = f.lineItems ?? [];
  return !f.lineItemsUnreconciled && items.length > 0 && items.every((li) => li.vatPercent != null);
}

/** One stated rate, and no row at any other (#511). */
function isSingleRateDocument(f: UvaFile): boolean {
  return singleDocumentRate(f.lineItems, null, f.vatPercent) !== null;
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
  if (lineItemsUsable(f)) {
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
