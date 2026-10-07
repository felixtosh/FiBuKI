/**
 * Mail header scan (#103, option C).
 *
 * Every few hours, read only the headers (sender, subject, date) of the mail
 * that arrived in a connected mailbox since the last scan. No bodies, no
 * attachments, no AI. A header is a trigger, never a File:
 *
 * - the sender's domain belongs to a Partner that has an open expense
 *   Transaction shortly before the mail: run the receipt search for that
 *   Transaction;
 * - the sender is unknown but the subject carries an invoice keyword: run the
 *   search for the few open Transactions closest to the mail's date;
 * - anything else is ignored.
 *
 * Transaction-first by construction: the mail only ever points the existing
 * per-Transaction search at a Transaction that is already open.
 */

import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { INVOICE_KEYWORDS } from "../mail/constants";
import type { MailMessage, MailProvider } from "../mail/provider";
import { isSearchableMailIntegration } from "../mail/searchable";
import { MAIL_PROVIDER_SECRETS, mailProviderForIntegration } from "../mail/searchMailboxes";
import { isPassiveMode } from "../utils/checkAutomationMode";
import { toDateSafe } from "../utils/toDateSafe";

/** Headers read per mailbox per scan. Bounds a busy inbox. */
export const HEADER_SCAN_MAX_MESSAGES = 200;
/** Receipt searches started per user per scan. Bounds AI spend. */
export const HEADER_SCAN_MAX_SEARCHES_PER_USER = 25;
/** The first scan of a mailbox looks this far back. */
export const HEADER_SCAN_FIRST_WINDOW_HOURS = 24;
/** A known Partner's mail can follow its payment by this much. */
export const KNOWN_SENDER_LOOKBACK_DAYS = 14;
/** An invoice-worded mail from an unknown sender is tied to Transactions this close. */
export const UNKNOWN_SENDER_LOOKBACK_DAYS = 10;
/** Open Transactions an unknown sender's mail may point the search at. */
export const UNKNOWN_SENDER_MAX_TRANSACTIONS = 3;

/** Fields kept on the integration between scans. */
export const HEADER_SCAN_CURSOR = "headerScanCursorAt";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

export interface HeaderScanReport {
  mailboxes: number;
  headers: number;
  knownSenderHits: number;
  keywordHits: number;
  searches: number;
  errors: number;
}

export interface HeaderScanDeps {
  now?: Date;
  /** A provider for one connected mailbox; injectable for tests. */
  providerFor?: (integrationId: string, integration: FirebaseFirestore.DocumentData) => Promise<MailProvider>;
  /** The per-Transaction receipt search; injectable for tests. */
  queueSearch?: (args: { transactionId: string; userId: string; partnerId?: string }) => Promise<unknown>;
}

/** The address in a From header, lowercased, or null. */
export function senderAddress(from: string): string | null {
  const angled = from.match(/<([^>]+)>/);
  const raw = (angled ? angled[1] : from).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : null;
}

/**
 * The domains a sender may be filed under: the full domain and, when it has
 * a subdomain, the registrable part (`billing.amazon.de` also tries
 * `amazon.de`). Partners store domains the same normalised way.
 */
export function senderDomains(from: string): string[] {
  const address = senderAddress(from);
  if (!address) return [];
  const domain = address.slice(address.indexOf("@") + 1);
  const labels = domain.split(".");
  const candidates = [domain];
  if (labels.length > 2) candidates.push(labels.slice(-2).join("."));
  return candidates;
}

const KEYWORD_PATTERN = new RegExp(
  `\\b(${INVOICE_KEYWORDS.map((k) => k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
  "i"
);

/** Whether a subject reads like an invoice or receipt. */
export function hasInvoiceKeyword(subject: string): boolean {
  return KEYWORD_PATTERN.test(subject);
}

async function defaultQueueSearch(args: { transactionId: string; userId: string; partnerId?: string }) {
  const { queueReceiptSearchForTransaction } = await import("../workers/runReceiptSearchForTransaction");
  return queueReceiptSearchForTransaction(args);
}

/** Headers of every message in the window, newest first, bounded. */
async function readHeaders(provider: MailProvider, dateFrom: Date, dateTo: Date): Promise<MailMessage[]> {
  const headers: MailMessage[] = [];
  let pageToken: string | undefined;
  while (headers.length < HEADER_SCAN_MAX_MESSAGES) {
    const page = await provider.search({
      // Every message in the window: no keyword sweep, no attachment filter.
      keywords: [],
      hasAttachment: false,
      dateFrom,
      dateTo,
      pageToken,
      limit: Math.min(50, HEADER_SCAN_MAX_MESSAGES - headers.length),
    });
    for (const ref of page.messages) {
      headers.push(await (provider.getHeaders ? provider.getHeaders(ref) : provider.getMessage(ref)));
    }
    if (!page.nextPageToken || page.messages.length === 0) break;
    pageToken = page.nextPageToken;
  }
  return headers;
}

function isOpenExpense(tx: FirebaseFirestore.DocumentData): boolean {
  if (tx.isComplete) return false;
  if (Array.isArray(tx.fileIds) && tx.fileIds.length > 0) return false;
  if (tx.noReceiptCategoryId) return false;
  return typeof tx.amount === "number" && tx.amount < 0;
}

async function scanMailbox(
  db: FirebaseFirestore.Firestore,
  integrationId: string,
  integration: FirebaseFirestore.DocumentData,
  deps: Required<HeaderScanDeps>,
  report: HeaderScanReport,
  searchedThisRun: Set<string>,
  perUser: Map<string, number>
): Promise<void> {
  const userId = integration.userId as string;
  const now = deps.now;
  const dateFrom =
    toDateSafe(integration[HEADER_SCAN_CURSOR]) ?? new Date(now.getTime() - HEADER_SCAN_FIRST_WINDOW_HOURS * MS_PER_HOUR);

  const provider = await deps.providerFor(integrationId, integration);
  let headers: MailMessage[];
  try {
    headers = await readHeaders(provider, dateFrom, now);
  } finally {
    await provider.close();
  }
  report.headers += headers.length;

  const partnersByDomain = new Map<string, string[]>();
  const lookupPartners = async (domain: string): Promise<string[]> => {
    if (!partnersByDomain.has(domain)) {
      const snap = await db
        .collection("partners")
        .where("userId", "==", userId)
        .where("isActive", "==", true)
        .where("emailDomains", "array-contains", domain)
        .get();
      partnersByDomain.set(domain, snap.docs.map((d) => d.id));
    }
    return partnersByDomain.get(domain)!;
  };

  const search = async (transactionId: string, partnerId?: string) => {
    if (searchedThisRun.has(transactionId)) return;
    if ((perUser.get(userId) ?? 0) >= HEADER_SCAN_MAX_SEARCHES_PER_USER) return;
    searchedThisRun.add(transactionId);
    perUser.set(userId, (perUser.get(userId) ?? 0) + 1);
    await deps.queueSearch({ transactionId, userId, partnerId });
    report.searches++;
  };

  for (const mail of headers) {
    const mailDate = mail.date;
    const partnerIds: string[] = [];
    for (const domain of senderDomains(mail.from)) {
      for (const id of await lookupPartners(domain)) {
        if (!partnerIds.includes(id)) partnerIds.push(id);
      }
    }

    if (partnerIds.length > 0) {
      report.knownSenderHits++;
      for (const partnerId of partnerIds) {
        const snap = await db
          .collection("transactions")
          .where("userId", "==", userId)
          .where("partnerId", "==", partnerId)
          .where("date", ">=", Timestamp.fromDate(new Date(mailDate.getTime() - KNOWN_SENDER_LOOKBACK_DAYS * MS_PER_DAY)))
          .where("date", "<=", Timestamp.fromDate(new Date(mailDate.getTime() + MS_PER_DAY)))
          .orderBy("date", "desc")
          .get();
        for (const doc of snap.docs) {
          if (isOpenExpense(doc.data())) await search(doc.id, partnerId);
        }
      }
      continue;
    }

    if (!hasInvoiceKeyword(mail.subject)) continue;
    report.keywordHits++;
    const snap = await db
      .collection("transactions")
      .where("userId", "==", userId)
      .where("isComplete", "==", false)
      .where("date", ">=", Timestamp.fromDate(new Date(mailDate.getTime() - UNKNOWN_SENDER_LOOKBACK_DAYS * MS_PER_DAY)))
      .where("date", "<=", Timestamp.fromDate(new Date(mailDate.getTime() + MS_PER_DAY)))
      .orderBy("date", "desc")
      .get();
    const candidates = snap.docs
      .filter((d) => isOpenExpense(d.data()))
      .map((d) => ({ id: d.id, partnerId: d.data().partnerId, distance: Math.abs((toDateSafe(d.data().date)?.getTime() ?? 0) - mailDate.getTime()) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, UNKNOWN_SENDER_MAX_TRANSACTIONS);
    for (const c of candidates) {
      await search(c.id, typeof c.partnerId === "string" ? c.partnerId : undefined);
    }
  }

  await db.collection("emailIntegrations").doc(integrationId).update({
    [HEADER_SCAN_CURSOR]: Timestamp.fromDate(now),
    headerScanLastCount: headers.length,
    updatedAt: Timestamp.fromDate(now),
  });
}

export async function scanMailHeaders(deps: HeaderScanDeps = {}): Promise<HeaderScanReport> {
  const db = getFirestore();
  const resolved: Required<HeaderScanDeps> = {
    now: deps.now ?? new Date(),
    providerFor: deps.providerFor ?? mailProviderForIntegration,
    queueSearch: deps.queueSearch ?? defaultQueueSearch,
  };
  const report: HeaderScanReport = { mailboxes: 0, headers: 0, knownSenderHits: 0, keywordHits: 0, searches: 0, errors: 0 };
  const searchedThisRun = new Set<string>();
  const perUser = new Map<string, number>();
  const passive = new Map<string, boolean>();

  // The receipt search's own rule for which mailboxes it reads (#746).
  const integrations = await db.collection("emailIntegrations").where("isActive", "==", true).get();

  for (const doc of integrations.docs) {
    const integration = doc.data();
    if (!isSearchableMailIntegration(integration)) continue;
    const userId = integration.userId as string | undefined;
    if (!userId) continue;
    if (!passive.has(userId)) passive.set(userId, await isPassiveMode(userId));
    if (passive.get(userId)) continue;
    report.mailboxes++;
    try {
      await scanMailbox(db, doc.id, integration, resolved, report, searchedThisRun, perUser);
    } catch (error) {
      // The cursor is not advanced, so the window is read again next time.
      report.errors++;
      console.error(`[HeaderScan] mailbox ${doc.id} failed:`, error);
    }
  }

  console.log(
    `[HeaderScan] ${report.mailboxes} mailboxes, ${report.headers} headers, ` +
      `${report.knownSenderHits} from known Partners, ${report.keywordHits} invoice-worded from unknown senders, ` +
      `${report.searches} receipt searches started, ${report.errors} errors`
  );
  return report;
}

export const scheduledMailHeaderScan = onSchedule(
  {
    schedule: "15 */6 * * *",
    timeZone: "Europe/Vienna",
    region: "europe-west1",
    memory: "512MiB",
    timeoutSeconds: 540,
    secrets: MAIL_PROVIDER_SECRETS,
  },
  async () => {
    await scanMailHeaders();
  }
);
