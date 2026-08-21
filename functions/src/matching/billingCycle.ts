/**
 * Pure billing-cycle derivation: interval mode detection, amount-band
 * splitting, and declared/learned resolution.
 *
 * No Firestore I/O here — the callable and the auto-learn triggers (post-file
 * connect, nightly) supply the transaction history and persist the result.
 *
 * Algorithm (per amount band):
 * 1. Compute inter-transaction intervals (days between consecutive charges)
 * 2. Find the mode interval (most common, within +/- 5 day tolerance)
 * 3. If mode has 3+ occurrences and covers >50% of intervals -> detected cycle
 * 4. Compute typical day-of-month from transaction dates
 * 5. If charges carry a connected file's extracted date, compute the
 *    invoice-to-transaction delay
 */

const MS_PER_DAY = 1000 * 60 * 60 * 24;

const MIN_TRANSACTIONS_PER_BAND = 3;
const MIN_INTERVALS = 2;
const INTERVAL_TOLERANCE_DAYS = 5;
const MIN_INTERVAL_OCCURRENCES = 3;
const MIN_INTERVAL_COVERAGE = 0.5;
const MIN_INVOICE_DELAYS = 3;
/** Also used downstream to pick the right band for a candidate amount (see `selectEffectiveCycleForAmount`). */
export const AMOUNT_BAND_TOLERANCE = 0.2;

export interface ModeIntervalResult {
  modeInterval: number;
  count: number;
  matchingIntervals: number[];
}

/** Find the most common interval within tolerance. */
export function findModeInterval(
  intervals: number[],
  tolerance: number
): ModeIntervalResult | null {
  if (intervals.length === 0) return null;

  let bestMode = 0;
  let bestCount = 0;
  let bestMatching: number[] = [];

  const sorted = [...intervals].sort((a, b) => a - b);
  const tested = new Set<number>();

  for (const center of sorted) {
    // Round to nearest 5 to avoid testing too many centers
    const rounded = Math.round(center / 5) * 5 || center;
    if (tested.has(rounded)) continue;
    tested.add(rounded);

    const matching = intervals.filter((i) => Math.abs(i - rounded) <= tolerance);

    if (matching.length > bestCount) {
      bestCount = matching.length;
      bestMode = rounded;
      bestMatching = matching;
    }
  }

  // Also test common billing periods
  for (const period of [7, 14, 30, 60, 90, 180, 365]) {
    const matching = intervals.filter((i) => Math.abs(i - period) <= tolerance);
    if (matching.length >= bestCount) {
      bestCount = matching.length;
      bestMode = period;
      bestMatching = matching;
    }
  }

  if (bestCount === 0) return null;

  return { modeInterval: bestMode, count: bestCount, matchingIntervals: bestMatching };
}

/** Compute the mode (most frequent value) of a number array. */
export function computeMode(values: number[]): number {
  const freq = new Map<number, number>();
  for (const v of values) {
    freq.set(v, (freq.get(v) || 0) + 1);
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

export interface BillingCycleTransaction {
  date: Date;
  /** Amount in the partner's billed currency — never the EUR conversion. */
  amount: number;
  /**
   * Extracted dates of every file connected to this transaction that carries
   * one. A transaction connected to more than one file (e.g. an invoice plus
   * a credit note) contributes one delay sample per file.
   */
  invoiceDates?: Date[];
}

export interface DerivedBillingCycle {
  /** Nominal amount of this recurrence's band. Unset when the partner has only one. */
  amountBand?: number;
  frequencyDays: number;
  frequencyConfidence: number;
  typicalDayOfMonth?: number;
  dayVariance?: number;
  invoiceToTransactionDelay?: number;
  delayVariance?: number;
  sampleSize: number;
}

/**
 * Split transactions into amount bands, then run interval detection on each
 * band independently. A partner billed at one steady amount yields a single
 * band (no `amountBand` set); a partner with distinct cadences at distinct
 * amounts (e.g. a weekly API charge and a monthly subscription) yields one
 * result per band.
 */
export function deriveLearnedCycles(
  transactions: BillingCycleTransaction[]
): DerivedBillingCycle[] {
  const bands = clusterByAmount(transactions, AMOUNT_BAND_TOLERANCE);
  const cycles: DerivedBillingCycle[] = [];

  for (const band of bands) {
    const cycle = deriveBandCycle(band.transactions);
    if (!cycle) continue;
    cycles.push({
      ...(bands.length > 1 ? { amountBand: round2(band.averageAmount) } : {}),
      ...cycle,
    });
  }

  return cycles;
}

interface AmountBand {
  transactions: BillingCycleTransaction[];
  averageAmount: number;
}

function clusterByAmount(
  transactions: BillingCycleTransaction[],
  tolerance: number
): AmountBand[] {
  const sorted = [...transactions].sort(
    (a, b) => Math.abs(a.amount) - Math.abs(b.amount)
  );
  const bands: AmountBand[] = [];

  for (const tx of sorted) {
    const amount = Math.abs(tx.amount);
    const current = bands[bands.length - 1];
    const withinTolerance =
      current &&
      (current.averageAmount === 0
        ? amount === 0
        : Math.abs(amount - current.averageAmount) / current.averageAmount <= tolerance);

    if (current && withinTolerance) {
      current.transactions.push(tx);
      current.averageAmount =
        current.transactions.reduce((s, t) => s + Math.abs(t.amount), 0) /
        current.transactions.length;
    } else {
      bands.push({ transactions: [tx], averageAmount: amount });
    }
  }

  return bands;
}

function deriveBandCycle(
  bandTransactions: BillingCycleTransaction[]
): Omit<DerivedBillingCycle, "amountBand"> | null {
  if (bandTransactions.length < MIN_TRANSACTIONS_PER_BAND) return null;

  const sorted = [...bandTransactions].sort((a, b) => a.date.getTime() - b.date.getTime());
  const dates = sorted.map((t) => t.date);
  const intervals: number[] = [];

  for (let i = 1; i < dates.length; i++) {
    const daysDiff = Math.round((dates[i].getTime() - dates[i - 1].getTime()) / MS_PER_DAY);
    if (daysDiff > 0) intervals.push(daysDiff);
  }

  if (intervals.length < MIN_INTERVALS) return null;

  const result = findModeInterval(intervals, INTERVAL_TOLERANCE_DAYS);
  if (!result) return null;

  const { modeInterval, count, matchingIntervals } = result;
  if (count < MIN_INTERVAL_OCCURRENCES || count / intervals.length < MIN_INTERVAL_COVERAGE) {
    return null;
  }

  const consistencyRatio = count / intervals.length;
  const avgDeviation =
    matchingIntervals.reduce((sum, i) => sum + Math.abs(i - modeInterval), 0) /
    matchingIntervals.length;
  const frequencyConfidence = Math.min(
    100,
    Math.round(consistencyRatio * 80 + Math.max(0, 20 - avgDeviation * 2))
  );

  const daysOfMonth = dates.map((d) => d.getDate());
  const typicalDayOfMonth = computeMode(daysOfMonth);
  const dayMean = daysOfMonth.reduce((s, d) => s + d, 0) / daysOfMonth.length;
  const dayVariance = Math.round(
    Math.sqrt(daysOfMonth.reduce((s, d) => s + (d - dayMean) ** 2, 0) / daysOfMonth.length)
  );

  const delays = sorted.flatMap((t) =>
    (t.invoiceDates ?? []).map((invoiceDate) =>
      Math.round((t.date.getTime() - invoiceDate.getTime()) / MS_PER_DAY)
    )
  );

  let invoiceToTransactionDelay: number | undefined;
  let delayVariance: number | undefined;
  if (delays.length >= MIN_INVOICE_DELAYS) {
    invoiceToTransactionDelay = Math.round(delays.reduce((s, d) => s + d, 0) / delays.length);
    delayVariance = Math.round(
      Math.sqrt(
        delays.reduce((s, d) => s + (d - invoiceToTransactionDelay!) ** 2, 0) / delays.length
      )
    );
  }

  return {
    frequencyDays: modeInterval,
    frequencyConfidence,
    typicalDayOfMonth,
    dayVariance,
    // Omitted entirely when unlearned (<3 delays): Firestore rejects
    // undefined values, and ignoreUndefinedProperties is never enabled.
    ...(invoiceToTransactionDelay !== undefined
      ? { invoiceToTransactionDelay, delayVariance }
      : {}),
    sampleSize: bandTransactions.length,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ============================================================================
// Declared / learned resolution
// ============================================================================

export type BillingDocumentExpectation = "invoice" | "no-receipt-category" | "nothing";

export interface DeclaredCycleInput {
  amountBand?: number;
  frequencyDays: number;
  expectedAmountMin?: number;
  expectedAmountMax?: number;
  documentExpectation?: BillingDocumentExpectation;
}

export interface ResolvedEffectiveCycle {
  amountBand?: number;
  source: "declared" | "learned";
  frequencyDays: number;
  frequencyConfidence?: number;
  typicalDayOfMonth?: number;
  dayVariance?: number;
  invoiceToTransactionDelay?: number;
  delayVariance?: number;
  documentExpectation?: BillingDocumentExpectation;
}

/**
 * Resolve declared and learned cycles into the effective view: a declared
 * recurrence always wins over its matching learned one, but still inherits
 * the learned day-of-month/delay so the effective view stays as precise as
 * what Fibuki has actually observed. A learned recurrence with no matching
 * declaration passes through unchanged.
 */
export function resolveEffectiveCycles(
  learned: DerivedBillingCycle[],
  declared: DeclaredCycleInput[] = []
): ResolvedEffectiveCycle[] {
  const matchedLearnedIndices = new Set<number>();
  const matchedDeclared: ResolvedEffectiveCycle[] = [];
  const unmatchedDeclared: ResolvedEffectiveCycle[] = [];

  for (const d of declared) {
    const matchIndex = findMatchingLearnedIndex(learned, d);
    const match = matchIndex === -1 ? undefined : learned[matchIndex];
    if (matchIndex !== -1) matchedLearnedIndices.add(matchIndex);

    const entry = omitUndefined({
      amountBand: d.amountBand,
      source: "declared" as const,
      frequencyDays: d.frequencyDays,
      typicalDayOfMonth: match?.typicalDayOfMonth,
      dayVariance: match?.dayVariance,
      invoiceToTransactionDelay: match?.invoiceToTransactionDelay,
      delayVariance: match?.delayVariance,
      documentExpectation: d.documentExpectation,
    });
    (matchIndex === -1 ? unmatchedDeclared : matchedDeclared).push(entry);
  }

  const unmatchedLearned = learned
    .map((l, i) => (matchedLearnedIndices.has(i) ? null : l))
    .filter((l): l is DerivedBillingCycle => l !== null)
    .map((l) =>
      omitUndefined({
        amountBand: l.amountBand,
        source: "learned" as const,
        frequencyDays: l.frequencyDays,
        frequencyConfidence: l.frequencyConfidence,
        typicalDayOfMonth: l.typicalDayOfMonth,
        dayVariance: l.dayVariance,
        invoiceToTransactionDelay: l.invoiceToTransactionDelay,
        delayVariance: l.delayVariance,
      })
    );

  // A declared cycle that matched a real recurrence always leads (it's the
  // authoritative view of that recurrence). An unmatched/ambiguous declared
  // cycle — nothing to enrich it with — sorts after every real learned band,
  // so a consumer that just wants "the" cycle doesn't land on a bare
  // placeholder ahead of actual signal.
  return [...matchedDeclared, ...unmatchedLearned, ...unmatchedDeclared];
}

/** Firestore rejects `undefined` values — drop keys that hold one. */
function omitUndefined<T extends object>(obj: T): T {
  const result = {} as T;
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

/**
 * Pick the effective cycle band a candidate amount belongs to. A partner
 * whose sole surviving band carries no `amountBand` (the true single-cycle
 * case) unambiguously matches. `amountBand` can still be set on a length-1
 * array — `deriveLearnedCycles` stamps it whenever the *clustering* found
 * more than one band, even if only one of them went on to produce a valid
 * cycle — so length alone is not a reliable signal; a set `amountBand`
 * always goes through the tolerance check below. No match within tolerance
 * returns `undefined` rather than guessing.
 */
export function selectEffectiveCycleForAmount<T extends { amountBand?: number }>(
  effective: T[],
  amount: number
): T | undefined {
  if (effective.length === 0) return undefined;
  if (effective.length === 1 && effective[0].amountBand === undefined) {
    return effective[0];
  }

  const absAmount = Math.abs(amount);
  let best: T | undefined;
  let bestDiff = Infinity;
  for (const band of effective) {
    if (band.amountBand === undefined) continue;
    // A zero-amount band (a free/trial recurrence) can't use a relative
    // tolerance — only an exact-zero candidate belongs to it.
    const diff =
      band.amountBand === 0
        ? absAmount === 0
          ? 0
          : Infinity
        : Math.abs(absAmount - band.amountBand) / band.amountBand;
    if (diff <= AMOUNT_BAND_TOLERANCE && diff < bestDiff) {
      best = band;
      bestDiff = diff;
    }
  }
  return best;
}

function findMatchingLearnedIndex(
  learned: DerivedBillingCycle[],
  declared: DeclaredCycleInput
): number {
  // A single learned recurrence never carries an amountBand (deriveLearnedCycles
  // only sets one when there's more than one band) — any declared cycle for
  // this partner unambiguously refers to it, scoped or not.
  if (learned.length === 1) return 0;

  // Against more than one learned band, an unscoped declaration is ambiguous.
  if (declared.amountBand === undefined) return -1;

  return learned.findIndex((l) => {
    if (l.amountBand === undefined) return false;
    if (declared.expectedAmountMin !== undefined && l.amountBand < declared.expectedAmountMin) {
      return false;
    }
    if (declared.expectedAmountMax !== undefined && l.amountBand > declared.expectedAmountMax) {
      return false;
    }
    if (declared.expectedAmountMin === undefined && declared.expectedAmountMax === undefined) {
      return (
        Math.abs(l.amountBand - declared.amountBand!) / declared.amountBand! <=
        AMOUNT_BAND_TOLERANCE
      );
    }
    return true;
  });
}
