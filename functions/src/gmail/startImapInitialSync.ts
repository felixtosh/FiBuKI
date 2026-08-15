import { getFirestore, Timestamp } from "firebase-admin/firestore";

/**
 * Kick off the initial IMAP sync for a freshly connected mailbox.
 *
 * ## Why this is a standalone module
 *
 * On Firebase this work belongs to the `onMailServiceConnected` Firestore
 * trigger, and that is still where it runs. On a self-host deployment the
 * trigger cannot fire for this write at all: trigger delivery rides the
 * in-process bus (`functions/src/selfhost/bus.ts`), whose auto-drain is enabled
 * only by the API entrypoint (`functions/src/selfhost/server.ts`). The IMAP
 * connect route runs in the *web* container, so the `emailIntegrations` write
 * lands on a bus with no handlers registered and the initial sync is never
 * queued — the mailbox connects, reports success, and then silently does
 * nothing forever. `functions/src/selfhost/change-notify.ts` already predicts
 * exactly this: the in-process bus "does not cross process boundaries [...] and
 * it would silently work in single-replica development while failing in any
 * deployment with a separate worker."
 *
 * The sync *queue*, unlike the bus, is a Firestore collection that the API
 * container polls, so a queue item written by any process is picked up
 * normally. Only the enqueue needed a home reachable from both containers.
 *
 * Deliberately imports no `firebase-functions` symbol: the web build aliases
 * `firebase-admin/firestore` to the self-host shim but has no shim for the
 * Functions SDK, so pulling one in here would drag Firebase into a
 * Firebase-free bundle.
 */

/** Collection polled by the sync worker (`gmailSyncQueue.ts`). */
const SYNC_QUEUE_COLLECTION = "gmailSyncQueue";
const INTEGRATIONS_COLLECTION = "emailIntegrations";

/** Days of slack added either side of the user's transaction span. */
const DATE_RANGE_PADDING_DAYS = 7;
/** Window used when the user has no transactions to bound the search with. */
const FALLBACK_WINDOW_DAYS = 90;

export interface StartImapInitialSyncParams {
  integrationId: string;
  userId: string;
  /** Only used for log lines and the user-facing notification. */
  email: string;
}

export interface StartImapInitialSyncResult {
  /** False when an initial sync was already queued and this call was a no-op. */
  queued: boolean;
  queueId?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

function addDays(date: Date, days: number): Date {
  const out = new Date(date);
  out.setDate(out.getDate() + days);
  return out;
}

/**
 * Widest span of the user's transactions, or null when they have none.
 *
 * Mail is only worth fetching around money that actually moved, so the search
 * window is derived from the transaction spine rather than from "recent".
 */
export async function getTransactionDateRange(
  userId: string
): Promise<{ minDate: Date; maxDate: Date } | null> {
  const db = getFirestore();

  const [earliestQuery, latestQuery] = await Promise.all([
    db
      .collection("transactions")
      .where("userId", "==", userId)
      .orderBy("date", "asc")
      .limit(1)
      .get(),
    db
      .collection("transactions")
      .where("userId", "==", userId)
      .orderBy("date", "desc")
      .limit(1)
      .get(),
  ]);

  if (earliestQuery.empty || latestQuery.empty) return null;

  const earliest = earliestQuery.docs[0].data();
  const latest = latestQuery.docs[0].data();

  // Historic rows carry a plain Date; anything written through the shim is a
  // Timestamp. Both shapes are live in the same collection.
  const toDate = (value: unknown): Date =>
    value instanceof Timestamp ? value.toDate() : new Date(value as string | number | Date);

  return { minDate: toDate(earliest.date), maxDate: toDate(latest.date) };
}

/**
 * Queue the initial sync for `integrationId`, unless one is already in flight.
 *
 * Idempotent on purpose: it is called from the connect route AND (on Firebase)
 * from the trigger, and a reconnect after a failed attempt must not stack a
 * second sync onto the same mailbox.
 */
export async function startImapInitialSync(
  params: StartImapInitialSyncParams
): Promise<StartImapInitialSyncResult> {
  const { integrationId, userId, email } = params;
  const db = getFirestore();

  const inFlight = await db
    .collection(SYNC_QUEUE_COLLECTION)
    .where("integrationId", "==", integrationId)
    .where("status", "in", ["pending", "processing"])
    .limit(1)
    .get();

  if (!inFlight.empty) {
    console.log(`[MailService] initial sync already queued for ${email}, skipping`);
    return { queued: false };
  }

  const range = await getTransactionDateRange(userId);
  const dateFrom = range
    ? addDays(range.minDate, -DATE_RANGE_PADDING_DAYS)
    : addDays(new Date(), -FALLBACK_WINDOW_DAYS);
  const dateTo = range ? addDays(range.maxDate, DATE_RANGE_PADDING_DAYS) : new Date();

  console.log(
    `[MailService] IMAP date range: ${dateFrom.toISOString()} to ${dateTo.toISOString()}`
  );

  const now = Timestamp.now();

  await db.collection(INTEGRATIONS_COLLECTION).doc(integrationId).update({
    initialSyncStartedAt: now,
    isPaused: false,
    updatedAt: now,
  });

  const queueRef = await db.collection(SYNC_QUEUE_COLLECTION).add({
    userId,
    integrationId,
    type: "initial",
    status: "pending",
    dateFrom: Timestamp.fromDate(dateFrom),
    dateTo: Timestamp.fromDate(dateTo),
    emailsProcessed: 0,
    filesCreated: 0,
    attachmentsSkipped: 0,
    errors: [],
    retryCount: 0,
    maxRetries: 3,
    processedMessageIds: [],
    createdAt: now,
  });

  console.log(`[MailService] IMAP integration auto-started: ${email}`);

  await db.collection("notifications").add({
    userId,
    type: "mail_service_connected",
    title: "Mailbox Connected",
    message: `${email} connected. Syncing recent invoices now.`,
    read: false,
    createdAt: now,
  });

  return { queued: true, queueId: queueRef.id, dateFrom, dateTo };
}
