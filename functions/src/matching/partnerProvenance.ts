/**
 * A Transaction Partner the payee rule filled from its Files, and what
 * removing one of those Files does to it (#584, ADR-0011).
 *
 * The payee rule fills an empty Transaction Partner when every connected File
 * names the same Partner. Every fill leaves a record of the Partner it wrote.
 * While the Transaction still holds exactly that Partner with the same
 * matched-by, the Partner is derived data: removing a File Connection derives
 * it again from the Files that remain.
 *
 *  1. The remaining Files agree on a Partner: the Transaction keeps or takes it.
 *  2. They do not: the fill goes, and the Transaction is matched again from its
 *     own bank data after the caller commits, with no agentic search.
 *
 * The guard is a comparison, not trust in every writer: any later Partner
 * write, by a person or a matcher, breaks the equality, so a writer that does
 * not know about the record cannot cause a wrong revert. The writers that make
 * a judgement also clear the record.
 *
 * The revert never records a manual removal: nobody said "not this Partner",
 * so the pair stays open to a later match on real evidence.
 */

import { Timestamp } from "firebase-admin/firestore";
import { payeeFillFromFiles, type FilePartnerRef, type PayeeFill } from "../partners/payeeRule";

type Doc = FirebaseFirestore.DocumentData;
type Ref = FirebaseFirestore.DocumentReference;
type Db = FirebaseFirestore.Firestore;

/** The record on a Transaction whose Partner the payee rule filled from its Files. */
export const TX_PROVENANCE = "partnerFromFiles";

export const CLEAR_TX_PROVENANCE = { [TX_PROVENANCE]: null } as const;

interface FillRecord {
  partnerId: string;
  matchedBy: string;
}

function readRecord(doc: Doc): FillRecord | null {
  const raw = doc[TX_PROVENANCE];
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.partnerId !== "string" || !r.partnerId) return null;
  if (typeof r.matchedBy !== "string" || !r.matchedBy) return null;
  return { partnerId: r.partnerId, matchedBy: r.matchedBy };
}

/**
 * The record while it still describes the Partner the Transaction holds;
 * null once anything has written over it.
 */
export function liveFillRecord(txData: Doc): FillRecord | null {
  const record = readRecord(txData);
  if (!record) return null;
  const holds =
    txData.partnerId === record.partnerId && (txData.partnerMatchedBy ?? null) === record.matchedBy;
  return holds ? record : null;
}

/** A payee fill with its record, as every server writer stores it. */
export function recordedFill(fill: PayeeFill): PayeeFill & { [TX_PROVENANCE]: FillRecord } {
  return {
    ...fill,
    [TX_PROVENANCE]: { partnerId: fill.partnerId, matchedBy: fill.partnerMatchedBy },
  };
}

/**
 * A Partner merge moves the pointer, not the judgement (ADR-0005): a record
 * that wrote the loser now names the survivor, so the revert still sees the
 * Transaction holding what it wrote. Empty when the record names no loser.
 */
export function repointProvenance(
  doc: Doc,
  loserId: string,
  survivorId: string
): Record<string, unknown> {
  const raw = doc[TX_PROVENANCE];
  if (!raw || typeof raw !== "object") return {};
  const record = raw as Record<string, unknown>;
  if (record.partnerId !== loserId) return {};
  return { [TX_PROVENANCE]: { ...record, partnerId: survivorId } };
}

// ============================================================================
// The revert
// ============================================================================

/** Reads a document; inside a Firestore transaction, pass `tx.get`. */
export type ReadDoc = (ref: Ref) => Promise<FirebaseFirestore.DocumentSnapshot>;

const plainRead: ReadDoc = (ref) => ref.get();

/** What a removed File Connection does to the Transaction's Partner. */
export interface PartnerRevert {
  /** Fields for the Transaction; empty when its Partner stays. */
  transaction: Record<string, unknown>;
  /** Activity entries for the Transaction; the caller adds them to its own arrayUnion. */
  transactionActivity: Record<string, unknown>[];
  /** Set when the Transaction lost its Partner and is matched again after the commit. */
  rematchTransactionId: string | null;
}

export interface RemovedConnection {
  fileId: string;
  fileData: Doc;
  transactionId: string;
  txData: Doc;
  /** Files still connected to the Transaction afterwards. */
  remainingFileIds: string[];
}

/**
 * Everything a removed File Connection changes about the Transaction's
 * Partner. All reads happen here, before the caller writes anything, so it is
 * safe inside a Firestore transaction given that transaction's `get`.
 */
export async function partnerRevertForRemovedConnection(
  db: Db,
  userId: string,
  removed: RemovedConnection,
  read: ReadDoc = plainRead
): Promise<PartnerRevert> {
  const { fileId, fileData, transactionId, txData } = removed;
  const none: PartnerRevert = { transaction: {}, transactionActivity: [], rematchTransactionId: null };
  if (!liveFillRecord(txData)) return none;

  const remainingIds = removed.remainingFileIds.filter((id) => id !== fileId);
  const snaps = await Promise.all(remainingIds.map((id) => read(db.collection("files").doc(id))));
  const remaining = snaps
    .filter((s) => s.exists && s.data()?.userId === userId && !s.data()?.deletedAt)
    .map((s) => s.data() as FilePartnerRef);

  const fill = payeeFillFromFiles({ partnerId: null }, remaining);
  if (fill && fill.partnerId === txData.partnerId) return none;

  const fileName = typeof fileData.fileName === "string" && fileData.fileName ? fileData.fileName : fileId;
  const entry = {
    ranAt: Timestamp.now(),
    status: "completed",
    actor: "auto",
    level: "outcome",
    fileId,
  };

  if (fill) {
    return {
      transaction: { ...recordedFill(fill) },
      transactionActivity: [
        {
          ...entry,
          type: "partner_assigned",
          forPartnerId: fill.partnerId,
          summary: `Partner taken from the Files still connected: File "${fileName}" was disconnected`,
        },
      ],
      rematchTransactionId: null,
    };
  }

  return {
    transaction: {
      partnerId: null,
      partnerType: null,
      partnerMatchedBy: null,
      partnerMatchConfidence: null,
      ...CLEAR_TX_PROVENANCE,
    },
    transactionActivity: [
      {
        ...entry,
        type: "partner_removed",
        forPartnerId: txData.partnerId ?? null,
        summary: `Partner removed: it came from File "${fileName}", which was disconnected`,
      },
    ],
    rematchTransactionId: transactionId,
  };
}

/**
 * Match the Transactions a revert left without a Partner again from their
 * bank data. Runs after the caller's commit; a failure is logged, never
 * thrown, because the disconnect it follows has already happened.
 */
export async function rematchRevertedTransactions(
  userId: string,
  transactionIds: Array<string | null>
): Promise<void> {
  const ids = [...new Set(transactionIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return;
  try {
    // Imported here: the matcher pulls in the whole Partner pipeline, which
    // the File callables that call this have no other use for.
    const { runPartnerMatching } = await import("./matchPartners");
    await runPartnerMatching(userId, { transactionIds: ids, agenticFallback: false });
  } catch (err) {
    console.error(`[partnerProvenance] Re-match after revert failed for ${ids.join(",")}:`, err);
  }
}
