/**
 * Timed receipt search (#103, option D).
 *
 * The receipt search runs once when a Transaction gets its Partner, which is
 * too early for a Partner that sends the invoice after the money moved
 * (Amazon, a telco mailing the bill after the debit). FiBuKI already learns
 * that lag per Partner (`billingCycle.effective[].invoiceToTransactionDelay`,
 * positive when the invoice precedes the payment, negative when it follows).
 * This job runs one more search per open Transaction, exactly once, at the
 * moment the invoice is expected to have arrived.
 *
 * Transaction-first by construction: nothing is fetched that no open
 * Transaction asked for. A Partner with no learned delay is left to the
 * header scan (option C) and the chase queue (option F).
 */

import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { isSearchableMailIntegration } from "../mail/searchable";
import { selectEffectiveCycleForAmount } from "../matching/billingCycle";
import { isPassiveMode } from "../utils/checkAutomationMode";
import { toDateSafe } from "../utils/toDateSafe";

/** How far back an open Transaction is still worth a timed search. */
export const TIMED_SEARCH_LOOKBACK_DAYS = 45;
/** Days added on top of the learned lag and its variance before searching. */
export const TIMED_SEARCH_GRACE_DAYS = 1;
/** Variance assumed for a Partner whose cycle carries none. */
const DEFAULT_DELAY_VARIANCE_DAYS = 2;
/** Bound on AI spend per user per run. */
export const TIMED_SEARCH_MAX_PER_USER = 25;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The field stamped on a Transaction once its timed search ran. */
export const TIMED_SEARCH_STAMP = "timedReceiptSearchAt";

export interface TimedSearchReport {
  users: number;
  considered: number;
  queued: number;
  notDue: number;
  unknownDelay: number;
}

/**
 * The day a Partner's invoice for `txDate` is expected to be in the mailbox:
 * the payment date, plus the lag when the invoice follows the payment, plus
 * the learned variance and one day of grace. For an invoice that precedes the
 * payment the lag is zero, so the search still runs once shortly after the
 * payment, which covers mail that arrived late.
 */
export function timedSearchDueDate(
  txDate: Date,
  invoiceToTransactionDelay: number,
  delayVariance: number | undefined
): Date {
  const lag = Math.max(0, -invoiceToTransactionDelay);
  const slack = (delayVariance ?? DEFAULT_DELAY_VARIANCE_DAYS) + TIMED_SEARCH_GRACE_DAYS;
  return new Date(txDate.getTime() + (lag + slack) * MS_PER_DAY);
}

export interface TimedSearchDeps {
  now?: Date;
  /** The per-Transaction receipt search; injectable for tests. */
  queueSearch?: (args: { transactionId: string; userId: string; partnerId: string }) => Promise<unknown>;
}

async function usersWithMailbox(db: FirebaseFirestore.Firestore): Promise<string[]> {
  // The receipt search's own rule for which mailboxes it reads (#746).
  const snap = await db.collection("emailIntegrations").where("isActive", "==", true).get();
  return [
    ...new Set(
      snap.docs
        .map((d) => d.data())
        .filter(isSearchableMailIntegration)
        .map((data) => data.userId as string)
        .filter(Boolean)
    ),
  ];
}

export async function runTimedReceiptSearches(deps: TimedSearchDeps = {}): Promise<TimedSearchReport> {
  const db = getFirestore();
  const now = deps.now ?? new Date();
  const queueSearch =
    deps.queueSearch ??
    (async (args) => {
      const { queueReceiptSearchForTransaction } = await import("../workers/runReceiptSearchForTransaction");
      return queueReceiptSearchForTransaction(args);
    });

  const report: TimedSearchReport = { users: 0, considered: 0, queued: 0, notDue: 0, unknownDelay: 0 };
  const since = Timestamp.fromDate(new Date(now.getTime() - TIMED_SEARCH_LOOKBACK_DAYS * MS_PER_DAY));

  for (const userId of await usersWithMailbox(db)) {
    if (await isPassiveMode(userId)) continue;
    report.users++;

    const open = await db
      .collection("transactions")
      .where("userId", "==", userId)
      .where("isComplete", "==", false)
      .where("date", ">=", since)
      .orderBy("date", "desc")
      .limit(500)
      .get();

    const cycles = new Map<string, unknown[] | null>();
    let queuedForUser = 0;

    for (const doc of open.docs) {
      if (queuedForUser >= TIMED_SEARCH_MAX_PER_USER) break;
      const tx = doc.data();
      const partnerId = typeof tx.partnerId === "string" ? tx.partnerId : null;
      const txDate = toDateSafe(tx.date);
      if (!partnerId || !txDate) continue;
      if (tx[TIMED_SEARCH_STAMP]) continue;
      if (Array.isArray(tx.fileIds) && tx.fileIds.length > 0) continue;
      if (tx.noReceiptCategoryId) continue;
      if (typeof tx.amount !== "number" || tx.amount >= 0) continue;
      report.considered++;

      if (!cycles.has(partnerId)) {
        const partner = await db.collection("partners").doc(partnerId).get();
        const effective = partner.data()?.billingCycle?.effective;
        cycles.set(partnerId, Array.isArray(effective) ? effective : null);
      }
      const effective = cycles.get(partnerId) as Array<{ amountBand?: number; invoiceToTransactionDelay?: number; delayVariance?: number }> | null;
      const band = effective ? selectEffectiveCycleForAmount(effective, tx.amount) : undefined;
      if (band?.invoiceToTransactionDelay == null) {
        report.unknownDelay++;
        continue;
      }

      if (now < timedSearchDueDate(txDate, band.invoiceToTransactionDelay, band.delayVariance)) {
        report.notDue++;
        continue;
      }

      // Stamped before the search, so a crash mid-run never searches twice.
      await doc.ref.update({ [TIMED_SEARCH_STAMP]: Timestamp.fromDate(now) });
      await queueSearch({ transactionId: doc.id, userId, partnerId });
      report.queued++;
      queuedForUser++;
    }
  }

  console.log(
    `[TimedReceiptSearch] ${report.users} users, ${report.considered} open transactions considered, ` +
      `${report.queued} searched, ${report.notDue} not due yet, ${report.unknownDelay} without a learned delay`
  );
  return report;
}

export const scheduledTimedReceiptSearch = onSchedule(
  {
    schedule: "30 4 * * *", // 04:30 Vienna, after the 03:00 billing-cycle learning
    timeZone: "Europe/Vienna",
    region: "europe-west1",
    memory: "512MiB",
    timeoutSeconds: 540,
  },
  async () => {
    await runTimedReceiptSearches();
  }
);
