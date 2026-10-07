/**
 * The one writer of File Connections (#612).
 *
 * A File Connection is three records that have to agree: the connection
 * record, the File's `transactionIds` and the Transaction's `fileIds`. Every
 * write of any of them goes through here: connect, Unlink, and the bulk
 * removals (deleting a File, deleting a bank account's Transactions, the Copy
 * swap). Every surface calls this module; no other code writes the three.
 *
 * - One record per pair by construction: the record id is derived from the
 *   File and the Transaction (`connectionDocId`), so a second connect of the
 *   same pair, from any writer and at the same moment, finds the first and
 *   changes nothing. Records written before #612 carry random ids and are
 *   still found by their fields; Unlink removes every record of a pair.
 * - A record counts only while both lists name its pair (#642). Connecting a
 *   pair whose record a list misses is a fresh connect: it completes both
 *   lists and leaves the one record under the derived id.
 * - A connect takes a list of pairs and writes them in Firestore transactions
 *   of at most `CONNECT_CHUNK` pairs, so a run of any size neither exceeds a
 *   batch nor reuses one.
 * - What a connect may do keys on its Connection Origin (rules.ts).
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "../utils/createCallable";
import { deriveActivityLevel } from "../utils/activityLevel";
import {
  cancelFileWorkersForTransaction,
  cancelPrecisionSearchForTransaction,
  cancelTransactionWorkersForFile,
} from "../utils/cancelWorkers";
import { isTransactionDismissed } from "../matching/dismissedTransactions";
import { isFileRejected } from "../matching/rejectedFiles";
import { buildUndismissSuggestionUpdates } from "../files/dismissSuggestionOps";
import { buildUnrejectFileUpdates } from "../files/rejectFileOps";
import { CLEARED_COPY_MARK, copyRefusalMessage, isLiveCopy } from "../files/copyOps";
import { payeeFillForTransaction } from "../partners/payeeSync";
import {
  partnerRevertForRemovedConnection,
  rematchRevertedTransactions,
  type PartnerRevert,
} from "../matching/partnerProvenance";
import {
  CONNECTION_TYPE_LABELS,
  ORIGIN_RULES,
  connectionDocId,
  rejectionRule,
  type ConnectionOrigin,
} from "./rules";
import {
  learnFromConnection,
  unlearnFileSourcePattern,
  type FileConnectionSourceInfo,
} from "./learning";

export type { FileConnectionSourceInfo } from "./learning";

type Db = FirebaseFirestore.Firestore;
type Data = FirebaseFirestore.DocumentData;
type Tx = FirebaseFirestore.Transaction;
type DocRef = FirebaseFirestore.DocumentReference;
type QueryDoc = FirebaseFirestore.QueryDocumentSnapshot;

const CONNECTIONS = "fileConnections";

/** Pairs per Firestore transaction: three writes each stays under a batch's 500. */
export const CONNECT_CHUNK = 100;

/** Firestore's limit on the values of an `in` filter. */
const IN_LIMIT = 30;

const AUTOMATED_TYPES = new Set(["auto_matched", "ai_matched"]);

/** The source fields a record keeps; anything else a caller sends is dropped. */
const SOURCE_INFO_FIELDS: ReadonlyArray<keyof FileConnectionSourceInfo> = [
  "sourceType",
  "searchPattern",
  "gmailIntegrationId",
  "gmailIntegrationEmail",
  "mailMessageId",
  "gmailMessageFrom",
  "gmailMessageFromName",
  "resultType",
];

// ============================================================================
// Connect
// ============================================================================

export interface ConnectPair {
  fileId: string;
  transactionId: string;
  /** The match confidence the connect is made at. Ignored for `suggestion`: the server reads it. */
  matchConfidence?: number | null;
  matchSources?: unknown;
  scoreBreakdown?: unknown;
  /**
   * Why an auto-connect was allowed when it was not the full-amount case.
   * `remainder_same_day` (#242): the File closed the Remainder of same-day
   * evidence. `paired` (#571): the File followed its Receipt Link's other
   * File onto the Transaction, past the Coverage gate. `instalment` (#615):
   * one payment of several of the File, on printed evidence (ADR-0013).
   */
  autoConnectReason?: "remainder_same_day" | "paired" | "instalment";
  aiReasoning?: string;
  sourceInfo?: FileConnectionSourceInfo;
  /** A stored label other than the origin's own; only those in CONNECTION_TYPE_LABELS. */
  connectionType?: string;
}

export interface ConnectOptions {
  origin: ConnectionOrigin;
  /** The agent's "a human asked for this exact pair": lifts a Rejection instead of refusing. */
  overrideRejection?: boolean;
  /**
   * Take automated File Connections of this File and this Transaction apart
   * to make room. A File or Transaction holding a Connection a person made is
   * refused instead (the agent's receipt search).
   */
  replaceAutomated?: boolean;
}

export type RefusalReason =
  | "invalid"
  | "missing"
  | "foreign"
  | "deleted"
  | "copy"
  | "over-quota"
  | "rejected"
  | "locked";

export type ConnectOutcome =
  | {
      fileId: string;
      transactionId: string;
      status: "connected";
      connectionId: string;
      /** Automated Connections taken apart to make room (`replaceAutomated`). */
      reassignedConnections: number;
    }
  | { fileId: string; transactionId: string; status: "already-connected"; connectionId: string }
  | {
      fileId: string;
      transactionId: string;
      status: "refused";
      reason: RefusalReason;
      code: "invalid-argument" | "not-found" | "permission-denied" | "failed-precondition";
      message: string;
    };

export const PAIR_REJECTED_MESSAGE =
  "PAIR_REJECTED: this file was rejected for this transaction. " +
  "Use undismiss_transaction_suggestion first if connecting it is genuinely intended.";

export const OVER_QUOTA_MESSAGE =
  "Automated file matching is disabled for over-quota transactions. Only a connect made in the app can add a file to one.";

/**
 * Connect a list of pairs. Each pair comes back with its outcome, in order;
 * a refused pair does not stop the others.
 */
export async function connectFiles(
  db: Db,
  userId: string,
  pairs: ConnectPair[],
  options: ConnectOptions
): Promise<ConnectOutcome[]> {
  const outcomes: ConnectOutcome[] = new Array(pairs.length);
  const work: Array<{ index: number; pair: ConnectPair }> = [];
  const firstByKey = new Map<string, number>();
  const repeats: Array<{ index: number; of: number }> = [];

  pairs.forEach((pair, index) => {
    const fileId = pair?.fileId;
    const transactionId = pair?.transactionId;
    if (typeof fileId !== "string" || !fileId || typeof transactionId !== "string" || !transactionId) {
      outcomes[index] = refusal(
        String(fileId ?? ""),
        String(transactionId ?? ""),
        "invalid",
        "invalid-argument",
        "fileId and transactionId are required"
      );
      return;
    }
    const key = connectionDocId(fileId, transactionId);
    const first = firstByKey.get(key);
    if (first !== undefined) {
      repeats.push({ index, of: first });
      return;
    }
    firstByKey.set(key, index);
    work.push({ index, pair });
  });

  const prepared = await prepareConnects(db, userId, work.map((w) => w.pair), options);

  const connected: ConnectedPair[] = [];
  for (let i = 0; i < work.length; i += CONNECT_CHUNK) {
    const chunk = work.slice(i, i + CONNECT_CHUNK);
    const plan = await db.runTransaction((tx) =>
      planConnects(tx, db, userId, chunk.map((w) => w.pair), options, prepared)
    );
    chunk.forEach((w, j) => {
      outcomes[w.index] = plan.outcomes[j];
    });
    await afterConnects(db, userId, plan, options);
    connected.push(...plan.connected);
  }
  await followReceiptLinks(db, userId, connected);

  for (const { index, of } of repeats) {
    const first = outcomes[of];
    outcomes[index] =
      first.status === "connected"
        ? { fileId: first.fileId, transactionId: first.transactionId, status: "already-connected", connectionId: first.connectionId }
        : first;
  }
  return outcomes;
}

/** One pair; a refusal throws, with the code a callable answers with. */
export async function connectFile(
  db: Db,
  userId: string,
  pair: ConnectPair,
  options: ConnectOptions
): Promise<Exclude<ConnectOutcome, { status: "refused" }>> {
  const [outcome] = await connectFiles(db, userId, [pair], options);
  if (outcome.status === "refused") throw new HttpsError(outcome.code, outcome.message);
  return outcome;
}

function refusal(
  fileId: string,
  transactionId: string,
  reason: RefusalReason,
  code: Extract<ConnectOutcome, { status: "refused" }>["code"],
  message: string
): ConnectOutcome {
  return { fileId, transactionId, status: "refused", reason, code, message };
}

interface Prepared {
  /** Global Partner id -> the user's own copy (directed origins). */
  localized: Map<string, string>;
  /** Server-side evidence for an accepted suggestion the File no longer stores. */
  scored: Map<string, { confidence: number | null; matchSources: unknown }>;
}

/**
 * The work a connect needs that cannot run inside a Firestore transaction:
 * copying a global Partner to the user (a write) and scoring a pair whose
 * suggestion is not stored (many reads).
 */
async function prepareConnects(
  db: Db,
  userId: string,
  pairs: ConnectPair[],
  options: ConnectOptions
): Promise<Prepared> {
  const prepared: Prepared = { localized: new Map(), scored: new Map() };
  const directed = ORIGIN_RULES[options.origin].learning === "directed";
  if (!directed || pairs.length === 0) return prepared;

  const files = await readOwned(db, "files", userId, pairs.map((p) => p.fileId));
  const txs = await readOwned(db, "transactions", userId, pairs.map((p) => p.transactionId));

  const globalIds = new Set<string>();
  for (const data of [...files.values(), ...txs.values()]) {
    if (data.partnerType === "global" && typeof data.partnerId === "string" && data.partnerId) {
      globalIds.add(data.partnerId);
    }
  }
  if (globalIds.size > 0) {
    // Imported here: the module reads Firestore at load.
    const { createLocalPartnerFromGlobal } = await import("../matching/createLocalPartnerFromGlobal");
    for (const globalId of globalIds) {
      try {
        prepared.localized.set(globalId, await createLocalPartnerFromGlobal(userId, globalId));
      } catch (err) {
        // A failed copy keeps the global id rather than failing the connect.
        console.error(`[fileConnections] Failed to localize global partner ${globalId}:`, err);
      }
    }
  }

  if (options.origin === "suggestion") {
    for (const pair of pairs) {
      const file = files.get(pair.fileId);
      if (!file || !txs.has(pair.transactionId)) continue;
      const stored = storedSuggestion(file, pair.transactionId);
      if (stored) continue;
      try {
        // The scorer the matcher and the connect dialog use, by id (#308).
        const { scoreFileTransactionMatch } = await import("../tools/handlers");
        const scored = await scoreFileTransactionMatch(userId, {
          fileId: pair.fileId,
          transactionId: pair.transactionId,
        });
        prepared.scored.set(connectionDocId(pair.fileId, pair.transactionId), {
          confidence: typeof scored.confidence === "number" ? scored.confidence : null,
          matchSources: scored.matchSources ?? null,
        });
      } catch (err) {
        console.error(`[fileConnections] Scoring ${pair.fileId}/${pair.transactionId} failed:`, err);
      }
    }
  }
  return prepared;
}

async function readOwned(
  db: Db,
  collection: string,
  userId: string,
  ids: string[]
): Promise<Map<string, Data>> {
  const unique = [...new Set(ids)];
  const snaps = unique.length ? await db.getAll(...unique.map((id) => db.collection(collection).doc(id))) : [];
  const out = new Map<string, Data>();
  for (const snap of snaps) {
    const data = snap.exists ? snap.data() : undefined;
    if (data && data.userId === userId) out.set(snap.id, data);
  }
  return out;
}

function storedSuggestion(
  fileData: Data,
  transactionId: string
): { transactionId: string; confidence?: number; matchSources?: unknown } | undefined {
  const list = Array.isArray(fileData.transactionSuggestions) ? fileData.transactionSuggestions : [];
  return list.find((s: { transactionId?: string }) => s?.transactionId === transactionId);
}

/** A document as the plan will leave it, and the fields the plan changed on it. */
class DocView {
  readonly changed = new Set<string>();
  readonly activity: Record<string, unknown>[] = [];
  private touched = false;
  constructor(readonly ref: DocRef, public data: Data) {}

  set(fields: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(fields)) {
      if (key === "updatedAt") continue;
      this.data[key] = value;
      this.changed.add(key);
    }
  }

  ids(field: "transactionIds" | "fileIds"): string[] {
    const value = this.data[field];
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  }

  add(field: "transactionIds" | "fileIds", id: string): void {
    const ids = this.ids(field);
    if (!ids.includes(id)) this.set({ [field]: [...ids, id] });
  }

  remove(field: "transactionIds" | "fileIds", id: string): void {
    const ids = this.ids(field);
    if (ids.includes(id)) this.set({ [field]: ids.filter((x) => x !== id) });
  }

  /** Write `updatedAt` even when no field changed. */
  touch(): void {
    this.touched = true;
  }

  write(tx: Tx, now: Timestamp): void {
    if (this.changed.size === 0 && this.activity.length === 0 && !this.touched) return;
    const update: Record<string, unknown> = { updatedAt: now };
    for (const key of this.changed) update[key] = this.data[key] ?? null;
    if (this.activity.length > 0) update.automationHistory = FieldValue.arrayUnion(...this.activity);
    tx.update(this.ref, update);
  }
}

interface ConnectedPair {
  fileId: string;
  transactionId: string;
  pair: ConnectPair;
  fileData: Data;
  partnerId: string | null;
}

interface ConnectPlan {
  outcomes: ConnectOutcome[];
  connected: ConnectedPair[];
  rematch: Set<string>;
}

/** Reads, decides and writes one chunk inside a Firestore transaction. No side effects. */
async function planConnects(
  tx: Tx,
  db: Db,
  userId: string,
  pairs: ConnectPair[],
  options: ConnectOptions,
  prepared: Prepared
): Promise<ConnectPlan> {
  const { origin } = options;
  const rules = ORIGIN_RULES[origin];
  const now = Timestamp.now();

  // ---- reads ----
  const fileIds = [...new Set(pairs.map((p) => p.fileId))];
  const txIds = [...new Set(pairs.map((p) => p.transactionId))];
  const fileSnaps = await tx.getAll(...fileIds.map((id) => db.collection("files").doc(id)));
  const txSnaps = await tx.getAll(...txIds.map((id) => db.collection("transactions").doc(id)));
  const files = new Map(fileSnaps.filter((s) => s.exists).map((s) => [s.id, new DocView(s.ref, { ...s.data() })]));
  const txs = new Map(txSnaps.filter((s) => s.exists).map((s) => [s.id, new DocView(s.ref, { ...s.data() })]));
  const ownedFileIds = fileIds.filter((id) => files.get(id)?.data.userId === userId);
  const ownedTxIds = txIds.filter((id) => txs.get(id)?.data.userId === userId);

  const connections = new Map<string, QueryDoc>();
  for (const ids of chunks(ownedFileIds, IN_LIMIT)) {
    const snap = await tx.get(connectionsWhere(db, userId, "fileId", ids));
    for (const doc of snap.docs) connections.set(doc.id, doc);
  }
  if (options.replaceAutomated) {
    for (const ids of chunks(ownedTxIds, IN_LIMIT)) {
      const snap = await tx.get(connectionsWhere(db, userId, "transactionId", ids));
      for (const doc of snap.docs) connections.set(doc.id, doc);
    }
  }

  const originalIds = [
    ...new Set(
      ownedFileIds
        .map((id) => files.get(id)!.data.copyOfFileId)
        .filter((id): id is string => typeof id === "string" && !!id)
    ),
  ];
  const originalSnaps = originalIds.length
    ? await tx.getAll(...originalIds.map((id) => db.collection("files").doc(id)))
    : [];
  const originals = new Map(originalSnaps.map((s) => [s.id, s.exists ? s.data() : undefined]));

  // Taking automated Connections apart reads the Files that stay, so every
  // revert is worked out before the first write.
  const removed = new Set<string>();
  const live = (doc: QueryDoc) => !removed.has(doc.id);
  const pairRecords = (fileId: string, transactionId: string) =>
    [...connections.values()].filter(
      (d) => live(d) && d.data().fileId === fileId && d.data().transactionId === transactionId
    );

  const outcomes: ConnectOutcome[] = [];
  const connected: ConnectedPair[] = [];
  const rematch = new Set<string>();
  const extraTxs = new Map<string, DocView>();
  const extraFiles = new Map<string, DocView>();
  const sets: Array<{ ref: DocRef; data: Data }> = [];

  const fileView = async (id: string): Promise<DocView | undefined> => {
    const known = files.get(id) ?? extraFiles.get(id);
    if (known) return known;
    const snap = await tx.get(db.collection("files").doc(id));
    if (!snap.exists || snap.data()?.userId !== userId) return undefined;
    const view = new DocView(snap.ref, { ...snap.data() });
    extraFiles.set(id, view);
    return view;
  };
  const txView = async (id: string): Promise<DocView | undefined> => {
    const known = txs.get(id) ?? extraTxs.get(id);
    if (known) return known;
    const snap = await tx.get(db.collection("transactions").doc(id));
    if (!snap.exists || snap.data()?.userId !== userId) return undefined;
    const view = new DocView(snap.ref, { ...snap.data() });
    extraTxs.set(id, view);
    return view;
  };

  for (const pair of pairs) {
    const { fileId, transactionId } = pair;
    const file = files.get(fileId);
    const t = txs.get(transactionId);
    if (!file) {
      outcomes.push(refusal(fileId, transactionId, "missing", "not-found", "File not found"));
      continue;
    }
    if (file.data.userId !== userId) {
      outcomes.push(refusal(fileId, transactionId, "foreign", "permission-denied", "File access denied"));
      continue;
    }
    if (!t) {
      outcomes.push(refusal(fileId, transactionId, "missing", "not-found", "Transaction not found"));
      continue;
    }
    if (t.data.userId !== userId) {
      outcomes.push(refusal(fileId, transactionId, "foreign", "permission-denied", "Transaction access denied"));
      continue;
    }

    // A File Connection is the record and both lists (#642). A record a list
    // does not name (written before #612) is none: the pair connects afresh,
    // under every rule below, and its record moves to the derived id.
    const existing = pairRecords(fileId, transactionId);
    const listed = file.ids("transactionIds").includes(transactionId) && t.ids("fileIds").includes(fileId);
    if (existing.length > 0 && listed) {
      // A person connecting a pair the matcher or the AI already connected
      // makes it theirs: the record takes this origin's label (keeping the old
      // one in `confirmedFrom`), and the Partner learns from it as from any
      // connect a person makes. Automation finding a connected pair changes
      // nothing.
      const automatedRecords = existing.filter((d) => AUTOMATED_TYPES.has(d.data().connectionType));
      if (rules.learning === "directed" && automatedRecords.length === existing.length) {
        for (const rec of automatedRecords) {
          sets.push({
            ref: rec.ref,
            data: {
              ...rec.data(),
              origin,
              connectionType: rules.connectionType,
              confirmedFrom: rec.data().connectionType,
              confirmedAt: now,
            },
          });
        }
        connected.push({
          fileId,
          transactionId,
          pair,
          fileData: file.data,
          partnerId: (t.data.partnerId as string | undefined) || (file.data.partnerId as string | undefined) || null,
        });
      }
      outcomes.push({
        fileId,
        transactionId,
        status: "already-connected",
        connectionId: earliest(existing).id,
      });
      continue;
    }

    if (file.data.deletedAt || file.data.purgedAt) {
      outcomes.push(
        refusal(fileId, transactionId, "deleted", "failed-precondition", "A deleted File holds no File Connection. Restore it first.")
      );
      continue;
    }

    // ADR-0010: a Copy holds no File Connection. A mark whose original is
    // gone is cleared by the connect, so restoring the original does not turn
    // a connected File back into a Copy.
    const originalId = file.data.copyOfFileId;
    let clearCopyMark = false;
    if (typeof originalId === "string" && originalId) {
      const original = originals.get(originalId);
      if (isLiveCopy(file.data, original)) {
        outcomes.push(
          refusal(fileId, transactionId, "copy", "failed-precondition", copyRefusalMessage(originalId, original))
        );
        continue;
      }
      clearCopyMark = true;
    }

    if (t.data.quotaExceeded && !rules.overQuota) {
      outcomes.push(refusal(fileId, transactionId, "over-quota", "failed-precondition", OVER_QUOTA_MESSAGE));
      continue;
    }

    const rejected = isTransactionDismissed(file.data, transactionId) || isFileRejected(t.data, fileId);
    if (rejected && rejectionRule(origin, options.overrideRejection === true) === "refuse") {
      outcomes.push(refusal(fileId, transactionId, "rejected", "failed-precondition", PAIR_REJECTED_MESSAGE));
      continue;
    }

    // ---- replace automated Connections (the agent's receipt search) ----
    let reassignedConnections = 0;
    if (options.replaceAutomated) {
      const onTx = [...connections.values()].filter(
        (d) => live(d) && d.data().transactionId === transactionId && d.data().fileId !== fileId
      );
      const onFile = [...connections.values()].filter(
        (d) => live(d) && d.data().fileId === fileId && d.data().transactionId !== transactionId
      );
      if (onTx.some((d) => !AUTOMATED_TYPES.has(d.data().connectionType))) {
        outcomes.push(
          refusal(fileId, transactionId, "locked", "failed-precondition",
            "Transaction has manual/user-confirmed file matches; refusing auto reassignment.")
        );
        continue;
      }
      if (onFile.some((d) => !AUTOMATED_TYPES.has(d.data().connectionType))) {
        outcomes.push(
          refusal(fileId, transactionId, "locked", "failed-precondition",
            "File has manual/user-confirmed transaction matches; refusing auto reassignment.")
        );
        continue;
      }
      for (const stale of [...onTx, ...onFile]) {
        if (removed.has(stale.id)) continue;
        const staleFileId = stale.data().fileId as string;
        const staleTxId = stale.data().transactionId as string;
        for (const rec of pairRecords(staleFileId, staleTxId)) removed.add(rec.id);
        reassignedConnections++;
        const staleFile = await fileView(staleFileId);
        const staleTx = await txView(staleTxId);
        staleFile?.remove("transactionIds", staleTxId);
        if (!staleTx) continue;
        const remaining = staleTx.ids("fileIds").filter((id) => id !== staleFileId);
        // A Partner the payee rule filled from the File taken off is derived
        // again from the Files that stay (#584).
        const revert = await partnerRevertForRemovedConnection(
          db,
          userId,
          { fileId: staleFileId, fileData: staleFile?.data ?? {}, transactionId: staleTxId, txData: staleTx.data, remainingFileIds: remaining },
          (ref) => tx.get(ref)
        );
        applyRevert(staleTx, revert, rematch);
        staleTx.remove("fileIds", staleFileId);
        if (staleTxId !== transactionId && remaining.length === 0 && !staleTx.data.noReceiptCategoryId) {
          staleTx.set({ isComplete: false });
        }
      }
    }

    // ---- connect ----
    const connectionId = connectionDocId(fileId, transactionId);
    for (const rec of existing) if (rec.id !== connectionId) removed.add(rec.id);

    const suggestions: Array<{ transactionId: string; confidence?: number; matchSources?: unknown }> =
      Array.isArray(file.data.transactionSuggestions) ? file.data.transactionSuggestions : [];
    const suggestedIndex = suggestions.findIndex((s) => s?.transactionId === transactionId);
    const stored = suggestedIndex >= 0 ? suggestions[suggestedIndex] : undefined;

    let confidence: number | null = pair.matchConfidence ?? null;
    let matchSources: unknown = pair.matchSources;
    if (origin === "suggestion") {
      // The server never takes a score from the client.
      const evidence = stored
        ? { confidence: stored.confidence ?? null, matchSources: stored.matchSources ?? null }
        : prepared.scored.get(connectionDocId(fileId, transactionId)) ?? { confidence: null, matchSources: null };
      confidence = evidence.confidence;
      matchSources = evidence.matchSources;
    }

    if (rejected) {
      // A person's pick, or the agent told so by a person: the Rejection is
      // taken back, stamped like an undone one.
      const fileSide = buildUndismissSuggestionUpdates(file.data, transactionId).updates;
      if (Object.keys(fileSide).length > 0) file.set(fileSide);
      const txSide = buildUnrejectFileUpdates(t.data, fileId).updates;
      if (Object.keys(txSide).length > 0) t.set(txSide);
    }

    const label =
      pair.connectionType && CONNECTION_TYPE_LABELS[origin]?.includes(pair.connectionType)
        ? pair.connectionType
        : rules.connectionType;
    const record: Data = {
      fileId,
      transactionId,
      userId,
      origin,
      connectionType: label,
      matchConfidence: confidence,
      wasSuggested: suggestedIndex >= 0,
      suggestedConfidence: stored?.confidence ?? null,
      suggestedRank: suggestedIndex >= 0 ? suggestedIndex : null,
      createdAt: now,
    };
    if (matchSources != null) record.matchSources = matchSources;
    if (pair.scoreBreakdown != null) record.scoreBreakdown = pair.scoreBreakdown;
    if (pair.autoConnectReason) record.autoConnectReason = pair.autoConnectReason;
    if (pair.aiReasoning) record.aiReasoning = pair.aiReasoning;
    for (const key of SOURCE_INFO_FIELDS) {
      const value = pair.sourceInfo?.[key];
      if (typeof value === "string" && value) record[key] = value;
    }
    sets.push({ ref: db.collection(CONNECTIONS).doc(connectionId), data: record });

    if (stored && origin === "suggestion") {
      file.set({ transactionSuggestions: suggestions.filter((s) => s?.transactionId !== transactionId) });
    }
    if (clearCopyMark) file.set({ ...CLEARED_COPY_MARK });

    // A connect writes only the user's own Partners: a global one is the
    // user's copy from here on.
    for (const view of [file, t]) {
      const local = view.data.partnerType === "global" ? prepared.localized.get(view.data.partnerId) : undefined;
      if (local) view.set({ partnerId: local, partnerType: "user" });
    }

    file.add("transactionIds", transactionId);
    t.add("fileIds", fileId);
    t.set({ isComplete: true });

    // The payee rule (ADR-0011): an empty Transaction Partner is filled only
    // when every File on it, this one included, names the same Partner.
    const known = new Map(
      [...files, ...extraFiles].filter(([, v]) => v.data.userId === userId).map(([id, v]) => [id, v.data])
    );
    const payeeFill = await payeeFillForTransaction(db, userId, t.data, { connectingFileId: fileId, known });
    if (payeeFill) t.set({ ...payeeFill });
    if (t.data.partnerId) rematch.delete(transactionId);

    t.activity.push({
      type: "file_connected",
      ranAt: now,
      status: "completed",
      actor: rules.actor,
      level: deriveActivityLevel({ type: "file_connected", actor: rules.actor }),
      fileId,
      fileName: file.data.fileName || null,
      confidence,
      summary: connectSummary(origin, file.data.fileName || fileId, confidence, pair.sourceInfo),
    });

    connected.push({
      fileId,
      transactionId,
      pair,
      fileData: file.data,
      partnerId: (t.data.partnerId as string | undefined) || (file.data.partnerId as string | undefined) || null,
    });
    outcomes.push({ fileId, transactionId, status: "connected", connectionId, reassignedConnections });
  }

  // ---- writes ----
  for (const id of removed) tx.delete(connections.get(id)!.ref);
  for (const { ref, data } of sets) tx.set(ref, data);
  for (const view of [...files.values(), ...extraFiles.values()]) {
    if (view.data.userId === userId) view.write(tx, now);
  }
  for (const view of [...txs.values(), ...extraTxs.values()]) {
    if (view.data.userId === userId) view.write(tx, now);
  }

  return { outcomes, connected, rematch };
}

function applyRevert(view: DocView, revert: PartnerRevert, rematch: Set<string>): void {
  if (Object.keys(revert.transaction).length > 0) view.set(revert.transaction);
  view.activity.push(...revert.transactionActivity);
  if (revert.rematchTransactionId) rematch.add(revert.rematchTransactionId);
  else if (revert.transaction.partnerId) rematch.delete(view.ref.id);
}

function connectSummary(
  origin: ConnectionOrigin,
  name: string,
  confidence: number | null,
  sourceInfo?: FileConnectionSourceInfo
): string {
  if (origin === "auto") {
    return confidence != null ? `File "${name}" auto-connected (${confidence}%)` : `File "${name}" auto-connected`;
  }
  if (origin === "ai") return `File "${name}" AI-matched`;
  const pattern = sourceInfo?.searchPattern?.trim();
  return pattern
    ? `File "${name}" connected (found via ${sourceInfo?.sourceType || "search"}: "${pattern}")`
    : `File "${name}" connected`;
}

async function afterConnects(db: Db, userId: string, plan: ConnectPlan, options: ConnectOptions): Promise<void> {
  if (options.origin === "manual") {
    // A person connecting a pair ends the automation still looking for it.
    for (const c of plan.connected) {
      cancelFileWorkersForTransaction(userId, c.transactionId).catch((err) =>
        console.error("[fileConnections] Failed to cancel transaction workers:", err)
      );
      cancelTransactionWorkersForFile(userId, c.fileId).catch((err) =>
        console.error("[fileConnections] Failed to cancel file workers:", err)
      );
      cancelPrecisionSearchForTransaction(userId, c.transactionId).catch((err) =>
        console.error("[fileConnections] Failed to cancel precision search:", err)
      );
    }
  }

  await rematchRevertedTransactions(userId, [...plan.rematch]);

  for (const c of plan.connected) {
    await learnFromConnection(db, userId, {
      origin: options.origin,
      partnerId: c.partnerId,
      transactionId: c.transactionId,
      fileData: c.fileData,
      sourceInfo: c.pair.sourceInfo,
    });
  }
}

/**
 * The matcher follows the pair (#571, ADR-0012 rule 6): whenever either File
 * of a Receipt Link is connected, by any origin, the other File is connected
 * to the same Transaction, origin `auto` and reason `paired`. The follow
 * skips the Coverage gate (the other File adds only its surplus) but not the
 * writer's own rules: a Rejection or the quota still refuse it.
 *
 * Never moves a File: one already connected anywhere stays where it is. A
 * File that would follow onto two Transactions at once follows onto none.
 * It fires on a connect only, so a person's Unlink of one File of a pair is
 * never undone here.
 */
async function followReceiptLinks(db: Db, userId: string, connected: ConnectedPair[]): Promise<void> {
  if (connected.length === 0) return;
  const txOf = new Map<string, Set<string>>();
  const note = (fileId: string, transactionId: string) => {
    const set = txOf.get(fileId) ?? new Set<string>();
    set.add(transactionId);
    txOf.set(fileId, set);
  };

  // Receipt to invoice: the link sits on the connected File.
  const invoiceIds = new Map<string, string[]>();
  for (const c of connected) {
    const invoiceId = c.fileData.receiptLink?.fileId;
    if (typeof invoiceId === "string" && invoiceId) {
      invoiceIds.set(invoiceId, [...(invoiceIds.get(invoiceId) ?? []), c.transactionId]);
    }
  }
  const partners = await readOwned(db, "files", userId, [...invoiceIds.keys()]);
  for (const [invoiceId, txIds] of invoiceIds) {
    if (partners.has(invoiceId)) for (const t of txIds) note(invoiceId, t);
  }

  // Invoice to Receipts: the links that point at the connected File.
  const byInvoice = new Map<string, string[]>();
  for (const c of connected) byInvoice.set(c.fileId, [...(byInvoice.get(c.fileId) ?? []), c.transactionId]);
  for (const ids of chunks([...byInvoice.keys()], IN_LIMIT)) {
    const snap = await db
      .collection("files")
      .where("userId", "==", userId)
      .where("receiptLink.fileId", "in", ids)
      .get();
    for (const doc of snap.docs) {
      partners.set(doc.id, doc.data());
      for (const t of byInvoice.get(doc.data().receiptLink.fileId) ?? []) note(doc.id, t);
    }
  }

  const follows: ConnectPair[] = [];
  for (const [fileId, txIds] of txOf) {
    const data = partners.get(fileId);
    if (!data || data.deletedAt || data.purgedAt || txIds.size !== 1) continue;
    if (Array.isArray(data.transactionIds) && data.transactionIds.length > 0) continue;
    follows.push({ fileId, transactionId: [...txIds][0], autoConnectReason: "paired" });
  }
  if (follows.length === 0) return;
  const outcomes = await connectFiles(db, userId, follows, { origin: "auto" });
  for (const o of outcomes) {
    if (o.status === "refused") {
      console.log(`[fileConnections] Pair follow ${o.fileId} -> ${o.transactionId} refused: ${o.reason}`);
    }
  }
}

// ============================================================================
// Unlink
// ============================================================================

export interface UnlinkRequest {
  fileId: string;
  transactionId: string;
  /** Record a Rejection with the Unlink, so automation does not propose the pair again. */
  reject?: boolean;
}

export interface UnlinkResult {
  success: true;
  /** Records of the pair removed; more than one only for a pair written twice before #612. */
  removedRecords: number;
}

/**
 * Take a File Connection apart. Removes every record of the pair, takes the
 * pair off both id lists, derives a Partner the payee rule filled from the
 * Files that remain, and lowers the learned file source pattern's use.
 */
export async function unlinkFile(db: Db, userId: string, request: UnlinkRequest): Promise<UnlinkResult> {
  const { fileId, transactionId, reject = false } = request;
  if (!fileId || !transactionId) {
    throw new HttpsError("invalid-argument", "fileId and transactionId are required");
  }

  const result = await db.runTransaction(async (tx) => {
    const now = Timestamp.now();
    const [fileSnap, txSnap] = await tx.getAll(
      db.collection("files").doc(fileId),
      db.collection("transactions").doc(transactionId)
    );
    if (!fileSnap.exists) throw new HttpsError("not-found", "File not found");
    if (fileSnap.data()!.userId !== userId) throw new HttpsError("permission-denied", "File access denied");
    if (!txSnap.exists) throw new HttpsError("not-found", "Transaction not found");
    if (txSnap.data()!.userId !== userId) throw new HttpsError("permission-denied", "Transaction access denied");

    const records = await tx.get(
      db
        .collection(CONNECTIONS)
        .where("userId", "==", userId)
        .where("fileId", "==", fileId)
        .where("transactionId", "==", transactionId)
    );
    const file = new DocView(fileSnap.ref, { ...fileSnap.data() });
    const t = new DocView(txSnap.ref, { ...txSnap.data() });
    const before = { ...t.data };
    const remaining = t.ids("fileIds").filter((id) => id !== fileId);

    const revert = await partnerRevertForRemovedConnection(
      db,
      userId,
      { fileId, fileData: file.data, transactionId, txData: t.data, remainingFileIds: remaining },
      (ref) => tx.get(ref)
    );
    const connection = records.empty ? null : earliest(records.docs).data();

    // ---- writes ----
    for (const doc of records.docs) tx.delete(doc.ref);
    file.remove("transactionIds", transactionId);
    file.touch();
    t.remove("fileIds", fileId);
    if (Object.keys(revert.transaction).length > 0) t.set(revert.transaction);
    const fileName = file.data.fileName || null;
    t.activity.push(
      {
        type: "file_disconnected",
        ranAt: now,
        status: "completed",
        actor: "manual",
        level: "decision",
        fileId,
        fileName,
        summary: `File "${fileName || fileId}" disconnected`,
      },
      ...revert.transactionActivity
    );
    if (remaining.length === 0 && !t.data.noReceiptCategoryId) t.set({ isComplete: false });
    if (reject) {
      const ids = Array.isArray(t.data.rejectedFileIds) ? t.data.rejectedFileIds : [];
      const rejections = Array.isArray(t.data.rejectedFiles) ? t.data.rejectedFiles : [];
      t.set({
        rejectedFileIds: ids.includes(fileId) ? ids : [...ids, fileId],
        rejectedFiles: [
          ...rejections,
          { fileId, rejectedAt: now, matchConfidence: connection?.matchConfidence ?? null },
        ],
      });
    }
    file.write(tx, now);
    t.write(tx, now);

    return {
      removedRecords: records.size,
      connection,
      rematch: revert.rematchTransactionId,
      // The pattern was learned on the Partner the pair held, before any revert.
      patternPartnerId: (before.partnerId as string | undefined) ?? (file.data.partnerId as string | undefined) ?? null,
    };
  });

  if (result.connection && result.patternPartnerId) {
    try {
      await unlearnFileSourcePattern(db, userId, result.patternPartnerId, transactionId, result.connection);
    } catch (err) {
      console.error("[fileConnections] Failed to decrement file source pattern:", err);
    }
  }
  await rematchRevertedTransactions(userId, [result.rematch]);
  return { success: true, removedRecords: result.removedRecords };
}

// ============================================================================
// Bulk removals
// ============================================================================

/**
 * A Transaction a removed File was attached to, as it stands afterwards.
 * `isComplete` false means it re-opened; true means it still has another
 * document or carries a No-document Category.
 */
export interface DetachedTransaction {
  transactionId: string;
  isComplete: boolean;
  date: unknown;
  amount: number | null;
  currency: string | null;
  name: string | null;
  partner: string | null;
}

/**
 * Take a File off every Transaction it is on: deleting a File. Every record
 * of the File goes, and every Transaction listing it, with or without a
 * record behind the listing. The File's own list is emptied.
 */
export async function detachFile(
  db: Db,
  userId: string,
  fileId: string,
  fileData: Data
): Promise<{ removedConnections: number; detachedTransactions: DetachedTransaction[] }> {
  const records = await db
    .collection(CONNECTIONS)
    .where("fileId", "==", fileId)
    .where("userId", "==", userId)
    .get();
  const txIds = [
    ...new Set([
      ...records.docs.map((d) => d.data().transactionId as string).filter(Boolean),
      ...((fileData.transactionIds || []) as string[]),
    ]),
  ];

  const detachedTransactions: DetachedTransaction[] = [];
  const rematch: Array<string | null> = [];
  let removedConnections = 0;
  const now = Timestamp.now();

  for (const ids of chunks(txIds, CONNECT_CHUNK)) {
    const batch = db.batch();
    for (const transactionId of ids) {
      const pairRecords = records.docs.filter((d) => d.data().transactionId === transactionId);
      for (const doc of pairRecords) batch.delete(doc.ref);
      const txSnap = await db.collection("transactions").doc(transactionId).get();
      const txData = txSnap.data();
      if (!txSnap.exists || !txData || txData.userId !== userId) {
        removedConnections += pairRecords.length > 0 ? 1 : 0;
        continue;
      }
      const remaining = ((txData.fileIds || []) as string[]).filter((id) => id !== fileId);
      const isComplete = remaining.length > 0 || !!txData.noReceiptCategoryId;
      const revert = await partnerRevertForRemovedConnection(db, userId, {
        fileId,
        fileData,
        transactionId,
        txData,
        remainingFileIds: remaining,
      });
      rematch.push(revert.rematchTransactionId);
      batch.update(txSnap.ref, {
        ...revert.transaction,
        ...(revert.transactionActivity.length > 0
          ? { automationHistory: FieldValue.arrayUnion(...revert.transactionActivity) }
          : {}),
        fileIds: FieldValue.arrayRemove(fileId),
        isComplete,
        updatedAt: now,
      });
      removedConnections++;
      detachedTransactions.push({
        transactionId,
        isComplete,
        date: txData.date ?? null,
        amount: typeof txData.amount === "number" ? txData.amount : null,
        currency: txData.currency ?? null,
        name: txData.name ?? null,
        partner: txData.partner ?? null,
      });
    }
    await batch.commit();
  }

  await db.collection("files").doc(fileId).update({ transactionIds: [], updatedAt: now });
  await rematchRevertedTransactions(userId, rematch);
  return { removedConnections, detachedTransactions };
}

/**
 * Take every File off Transactions about to be deleted with their bank
 * account or import: their records go, and no File keeps listing them. The
 * caller deletes the Transactions afterwards.
 */
export async function detachTransactions(
  db: Db,
  userId: string,
  transactions: Array<{ id: string; data: Data }>
): Promise<{ removedRecords: number; filesUpdated: number }> {
  let removedRecords = 0;
  let filesUpdated = 0;
  const now = Timestamp.now();

  for (const group of chunks(transactions, IN_LIMIT)) {
    const ids = group.map((t) => t.id);
    const [records, listing] = await Promise.all([
      db.collection(CONNECTIONS).where("userId", "==", userId).where("transactionId", "in", ids).get(),
      db.collection("files").where("userId", "==", userId).where("transactionIds", "array-contains-any", ids).get(),
    ]);

    // Every File on these Transactions, by record, by the Transaction's list,
    // or by its own list.
    const byFile = new Map<string, Set<string>>();
    const note = (fileId: unknown, transactionId: string) => {
      if (typeof fileId !== "string" || !fileId) return;
      if (!byFile.has(fileId)) byFile.set(fileId, new Set());
      byFile.get(fileId)!.add(transactionId);
    };
    for (const doc of records.docs) note(doc.data().fileId, doc.data().transactionId);
    for (const t of group) for (const fileId of (t.data.fileIds || []) as string[]) note(fileId, t.id);
    for (const doc of listing.docs) {
      for (const transactionId of (doc.data().transactionIds || []) as string[]) {
        if (ids.includes(transactionId)) note(doc.id, transactionId);
      }
    }

    const batch = db.batch();
    for (const doc of records.docs) batch.delete(doc.ref);
    removedRecords += records.size;

    const fileSnaps = byFile.size
      ? await db.getAll(...[...byFile.keys()].map((id) => db.collection("files").doc(id)))
      : [];
    for (const snap of fileSnaps) {
      if (!snap.exists || snap.data()?.userId !== userId) continue;
      batch.update(snap.ref, {
        transactionIds: FieldValue.arrayRemove(...byFile.get(snap.id)!),
        updatedAt: now,
      });
      filesUpdated++;
    }
    await batch.commit();
  }
  return { removedRecords, filesUpdated };
}

// ============================================================================
// The Copy swap (ADR-0010)
// ============================================================================

export interface CopyMove {
  /** Transactions the original took over from the Copy. */
  moved: string[];
  /** Transactions the Copy came off where the original already was. */
  dropped: string[];
  rematch: Array<string | null>;
  /** The writes, after the caller's remaining reads. */
  write(tx: Tx): void;
}

/**
 * The File Connections of a File becoming a Copy, inside the caller's
 * Firestore transaction. Each Connection the Copy holds is taken apart; where
 * the original is not on that Transaction, the Connection moves to the
 * original, so no Transaction loses the document. Neither is a Rejection.
 *
 * Reads only; the returned `write` does the writing.
 */
export async function planCopyMove(
  tx: Tx,
  db: Db,
  userId: string,
  copy: { id: string; data: Data },
  original: { id: string; data: Data },
  summary: { recordedBy: "system" | "user"; copyName: string; originalName: string }
): Promise<CopyMove> {
  const [copyConnSnap, origConnSnap] = await Promise.all([
    tx.get(db.collection(CONNECTIONS).where("userId", "==", userId).where("fileId", "==", copy.id)),
    tx.get(db.collection(CONNECTIONS).where("userId", "==", userId).where("fileId", "==", original.id)),
  ]);

  const originalTxIds = new Set<string>([
    ...((original.data.transactionIds as string[] | undefined) ?? []),
    ...origConnSnap.docs.map((d) => d.data().transactionId as string),
  ]);

  // Every Transaction the copy is on: by record, and by its own list, which
  // may name one with no record behind it.
  const touchedTxIds = new Set<string>([
    ...copyConnSnap.docs.map((d) => d.data().transactionId as string).filter(Boolean),
    ...((copy.data.transactionIds as string[] | undefined) ?? []),
  ]);
  const txSnaps = await Promise.all(
    [...touchedTxIds].map((id) => tx.get(db.collection("transactions").doc(id)))
  );
  const ownedTx = txSnaps.filter((s) => s.exists && s.data()?.userId === userId);

  // Which Transactions the original takes over, decided here once, so the
  // Partner revert can count the original as still connected there.
  const moved = ownedTx.map((s) => s.id).filter((id) => !originalTxIds.has(id));
  const movedSet = new Set(moved);
  const dropped = ownedTx.map((s) => s.id).filter((id) => !movedSet.has(id));

  // A Partner the payee rule filled from the copy is derived again from the
  // Files that remain, the original included where it takes over (#584).
  const reverts = new Map<string, PartnerRevert>();
  const rematch: Array<string | null> = [];
  for (const txSnap of ownedTx) {
    const txData = txSnap.data()!;
    const remainingFileIds = ((txData.fileIds || []) as string[]).filter((id) => id !== copy.id);
    if (movedSet.has(txSnap.id)) remainingFileIds.push(original.id);
    const revert = await partnerRevertForRemovedConnection(
      db,
      userId,
      { fileId: copy.id, fileData: copy.data, transactionId: txSnap.id, txData, remainingFileIds },
      (ref) => tx.get(ref)
    );
    reverts.set(txSnap.id, revert);
    rematch.push(revert.rematchTransactionId);
  }

  const write = (t: Tx) => {
    const now = Timestamp.now();
    const recordByTx = new Map(copyConnSnap.docs.map((d) => [d.data().transactionId as string, d.data()]));
    for (const conn of copyConnSnap.docs) t.delete(conn.ref);
    for (const transactionId of moved) {
      const data = recordByTx.get(transactionId);
      t.set(db.collection(CONNECTIONS).doc(connectionDocId(original.id, transactionId)), {
        ...(data ?? { userId, connectionType: "manual", origin: "manual" }),
        fileId: original.id,
        transactionId,
        movedFromCopyFileId: copy.id,
        createdAt: now,
      });
    }

    for (const txSnap of ownedTx) {
      const takesOver = movedSet.has(txSnap.id);
      const revert = reverts.get(txSnap.id);
      const fileIds = ((txSnap.data()!.fileIds || []) as string[]).filter((id) => id !== copy.id);
      if (takesOver && !fileIds.includes(original.id)) fileIds.push(original.id);
      t.update(txSnap.ref, {
        ...(revert?.transaction ?? {}),
        fileIds,
        updatedAt: now,
        automationHistory: FieldValue.arrayUnion(
          {
            type: "file_disconnected",
            ranAt: now,
            status: "completed",
            actor: summary.recordedBy === "user" ? "manual" : "auto",
            level: "decision",
            fileId: copy.id,
            fileName: copy.data.fileName ?? null,
            summary: takesOver
              ? `File "${summary.copyName}" marked as a Copy of "${summary.originalName}"; the original now documents this line`
              : `File "${summary.copyName}" marked as a Copy of "${summary.originalName}"`,
          },
          ...(revert?.transactionActivity ?? [])
        ),
      });
    }

    if (moved.length > 0) {
      t.update(db.collection("files").doc(original.id), {
        transactionIds: FieldValue.arrayUnion(...moved),
        updatedAt: now,
      });
    }
    t.update(db.collection("files").doc(copy.id), { transactionIds: [], updatedAt: now });
  };

  return { moved, dropped, rematch, write };
}

// ============================================================================
// Re-scoring
// ============================================================================

export interface ConnectionScore {
  connectionId: string;
  matchConfidence: number;
  scoreBreakdown: unknown;
  matchSources: unknown;
}

/**
 * Store a fresh score on existing records (a Partner's billing cycle changed,
 * yazzbert/FiBuKI-selfhost#168). Never creates or removes a File Connection
 * and never touches the id lists.
 */
export async function writeConnectionScores(db: Db, scores: ConnectionScore[]): Promise<number> {
  const now = Timestamp.now();
  for (const group of chunks(scores, 400)) {
    const batch = db.batch();
    for (const score of group) {
      batch.update(db.collection(CONNECTIONS).doc(score.connectionId), {
        matchConfidence: score.matchConfidence,
        scoreBreakdown: score.scoreBreakdown,
        matchSources: score.matchSources,
        rescoredAt: now,
      });
    }
    await batch.commit();
  }
  return scores.length;
}

// ============================================================================
// Helpers
// ============================================================================

function connectionsWhere(db: Db, userId: string, field: "fileId" | "transactionId", ids: string[]) {
  const base = db.collection(CONNECTIONS).where("userId", "==", userId);
  return ids.length === 1 ? base.where(field, "==", ids[0]) : base.where(field, "in", ids);
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function createdMillis(data: Data): number {
  const at = data.createdAt as { toMillis?: () => number } | undefined;
  return typeof at?.toMillis === "function" ? at.toMillis() : Number.MAX_SAFE_INTEGER;
}

/** The record a pair keeps when it has several: the earliest written. */
function earliest(docs: QueryDoc[]): QueryDoc {
  return [...docs].sort((a, b) => createdMillis(a.data()) - createdMillis(b.data()) || a.id.localeCompare(b.id))[0];
}

export { earliest as earliestConnectionRecord };
