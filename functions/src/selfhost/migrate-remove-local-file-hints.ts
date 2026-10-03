/**
 * #590: one-time pass that takes the precision-search hints of the two
 * local-file strategies off stored Files, and lists the File Connections those
 * strategies made, for review by hand.
 *
 * Before #589 the `partner_files` and `amount_files` strategies scored a stored
 * File with the attachment scorer and, at 60 or more, wrote a
 * `precisionSearchHint` on it. The matcher values that hint at 25 to 40 points
 * every time the File is matched again, so a hint left on a File keeps
 * inflating its Matches long after #589 stopped writing new ones. This pass:
 *
 * - deletes `precisionSearchHint` from every File whose hint names one of the
 *   two strategies. A hint from an email strategy (`email_attachment`,
 *   `email_invoice`) stays: the email is evidence the matcher does not have.
 * - lists the File Connections the two strategies made, read-only. It
 *   disconnects nothing and writes nothing to a File Connection.
 *
 * Which connections it lists. The File holds one hint at a time and this pass
 * deletes it, so the hint cannot be the evidence (a second run would find
 * none). The search attempt records under `transactions/{id}/searches` can:
 * every attempt names its strategy and, in `fileIdsConnected`, the Files it
 * hinted for that Transaction. A File Connection is listed when
 *
 *   - it is `auto_matched` (the matcher made it; a person's or an agent's
 *     connection is their own decision), and
 *   - an attempt of `partner_files` or `amount_files` on its Transaction
 *     hinted its File.
 *
 * Those strategies only ever picked Files connected to nothing, so such a
 * connection was made after the hint, by the matcher run the hint triggered
 * or a later one that still carried it. `until` bounds the attempts read:
 * after #589 an attempt can name a strategy for a connection the matcher made
 * on a nomination worth zero points, and that is not one to review.
 *
 * Postgres only, like every selfhost migrate-* pass: `firebase-admin/firestore`
 * resolves to the Postgres-backed shim, the module is never wired into
 * functions/src/index.ts, so it cannot reach the retained Firebase project.
 *
 * Removing the field fires the `files/{id}` update triggers, and none of them
 * acts on it: matching re-runs only when `transactionMatchComplete` flips to
 * false, partner matching only on extraction or a Partner change.
 *
 * Idempotent: a second run finds no hint to remove and reads the same attempt
 * records and connections, so it lists the same connections.
 *
 * A backup precedes the write: every hint about to be deleted is written to a
 * JSON file first, so a bad run can be undone without a restore.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";

/** The strategies that wrote a hint on a File that was already stored. */
export const LOCAL_FILE_STRATEGIES: ReadonlySet<string> = new Set(["partner_files", "amount_files"]);

export interface RemovedHint {
  fileId: string;
  userId: string | null;
  precisionSearchHint: Record<string, unknown>;
}

export interface ConnectionToReview {
  connectionId: string;
  userId: string | null;
  fileId: string;
  fileName: string | null;
  transactionId: string;
  /** Vienna calendar day, YYYY-MM-DD. */
  transactionDate: string | null;
  /** Cents, negative = expense. */
  transactionAmount: number | null;
  transactionCurrency: string | null;
  transactionName: string | null;
  transactionPartner: string | null;
  /** The strategies whose hint names this File for this Transaction. */
  strategies: string[];
  /** ISO date-time the connection was made. */
  connectedAt: string | null;
  /** The match confidence stored on the connection, where it is recorded. */
  matchConfidence: number | null;
}

export interface RemoveLocalFileHintsReport {
  filesScanned: number;
  /** Hints removed, or that a dry run would remove. */
  hintsRemoved: RemovedHint[];
  /** Email-strategy hints left on their Files. */
  hintsKept: number;
  connectionsToReview: ConnectionToReview[];
  /** The review list as CSV, always written. */
  listPath: string;
  /** Pre-write backup of the removed hints, or null when nothing was removed. */
  backupPath: string | null;
}

export interface RemoveLocalFileHintsOptions {
  apply: boolean;
  /** Where the review list and the backup are written. */
  outDir: string;
  /** Only attempts started before this moment count (the time #589 went live). */
  until?: Date;
  log?: (line: string) => void;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  return null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Transaction id → File id → strategies that hinted the File for it. */
async function readHintedPairs(until: Date | undefined): Promise<Map<string, Map<string, Set<string>>>> {
  const db = getFirestore();
  const snap = await db.collectionGroup("searches").get();
  const pairs = new Map<string, Map<string, Set<string>>>();

  for (const doc of snap.docs) {
    // transactions/{transactionId}/searches/{searchId}
    const segments = doc.ref.path.split("/");
    if (segments.length !== 4 || segments[0] !== "transactions") continue;
    const transactionId = segments[1];

    const attempts = (doc.data() as Record<string, unknown>).attempts;
    if (!Array.isArray(attempts)) continue;

    for (const raw of attempts) {
      if (raw === null || typeof raw !== "object") continue;
      const attempt = raw as Record<string, unknown>;
      const strategy = str(attempt.strategy);
      if (!strategy || !LOCAL_FILE_STRATEGIES.has(strategy)) continue;
      if (until) {
        const startedAt = toDate(attempt.startedAt);
        if (!startedAt || startedAt >= until) continue;
      }
      const fileIds = Array.isArray(attempt.fileIdsConnected) ? attempt.fileIdsConnected : [];
      for (const fileId of fileIds) {
        if (typeof fileId !== "string") continue;
        let byFile = pairs.get(transactionId);
        if (!byFile) pairs.set(transactionId, (byFile = new Map()));
        let strategies = byFile.get(fileId);
        if (!strategies) byFile.set(fileId, (strategies = new Set()));
        strategies.add(strategy);
      }
    }
  }
  return pairs;
}

const CSV_COLUMNS: Array<keyof ConnectionToReview> = [
  "connectedAt",
  "matchConfidence",
  "strategies",
  "fileName",
  "transactionDate",
  "transactionAmount",
  "transactionCurrency",
  "transactionName",
  "transactionPartner",
  "userId",
  "fileId",
  "transactionId",
  "connectionId",
];

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = Array.isArray(value) ? value.join(" ") : String(value);
  // A file name from a mailbox is untrusted: a spreadsheet would run "=..." as a formula.
  if (typeof value === "string" && /^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: ConnectionToReview[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) lines.push(CSV_COLUMNS.map((c) => csvCell(row[c])).join(","));
  return lines.join("\n") + "\n";
}

export async function removeLocalFileHints(
  opts: RemoveLocalFileHintsOptions,
): Promise<RemoveLocalFileHintsReport> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const db = getFirestore();

  // --- The review list: read before any write, from records this pass never changes.
  const hinted = await readHintedPairs(opts.until);
  const connectionsSnap = await db
    .collection("fileConnections")
    .where("connectionType", "==", "auto_matched")
    .get();

  const filesSnap = await db.collection("files").get();
  const filesById = new Map(filesSnap.docs.map((d) => [d.id, d.data() as Record<string, unknown>]));

  const connectionsToReview: ConnectionToReview[] = [];
  for (const doc of connectionsSnap.docs) {
    const conn = doc.data() as Record<string, unknown>;
    const fileId = str(conn.fileId);
    const transactionId = str(conn.transactionId);
    if (!fileId || !transactionId) continue;
    const strategies = hinted.get(transactionId)?.get(fileId);
    if (!strategies) continue;

    const tx = (await db.collection("transactions").doc(transactionId).get()).data() as
      | Record<string, unknown>
      | undefined;
    const file = filesById.get(fileId);
    const txDate = toDate(tx?.date);
    const connectedAt = toDate(conn.createdAt);

    connectionsToReview.push({
      connectionId: doc.id,
      userId: str(conn.userId),
      fileId,
      fileName: str(file?.fileName),
      transactionId,
      transactionDate: txDate ? txDate.toISOString().slice(0, 10) : null,
      transactionAmount: num(tx?.amount),
      transactionCurrency: str(tx?.currency),
      transactionName: str(tx?.name),
      transactionPartner: str(tx?.partner),
      strategies: [...strategies].sort(),
      connectedAt: connectedAt ? connectedAt.toISOString() : null,
      matchConfidence: num(conn.matchConfidence),
    });
  }
  connectionsToReview.sort(
    (a, b) => (a.connectedAt ?? "").localeCompare(b.connectedAt ?? "") || a.connectionId.localeCompare(b.connectionId),
  );

  // --- The hints to remove.
  const hintsRemoved: RemovedHint[] = [];
  let hintsKept = 0;
  for (const doc of filesSnap.docs) {
    const data = doc.data() as Record<string, unknown>;
    const hint = data.precisionSearchHint;
    if (hint === null || typeof hint !== "object") continue;
    const strategy = str((hint as Record<string, unknown>).searchStrategy);
    if (strategy && LOCAL_FILE_STRATEGIES.has(strategy)) {
      hintsRemoved.push({
        fileId: doc.id,
        userId: str(data.userId),
        precisionSearchHint: hint as Record<string, unknown>,
      });
    } else {
      hintsKept++;
    }
  }

  await fs.mkdir(opts.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  const listPath = path.join(opts.outDir, `local-file-hint-connections-${stamp}.csv`);
  await fs.writeFile(listPath, toCsv(connectionsToReview));
  log(`  review list: ${connectionsToReview.length} File Connection(s) written to ${listPath}`);

  let backupPath: string | null = null;
  if (opts.apply && hintsRemoved.length > 0) {
    backupPath = path.join(opts.outDir, `local-file-hints-removed-${stamp}.json`);
    await fs.writeFile(backupPath, JSON.stringify(hintsRemoved, null, 2));
    log(`  backup: ${hintsRemoved.length} hint(s) written to ${backupPath}`);
    for (const removed of hintsRemoved) {
      await db.collection("files").doc(removed.fileId).update({ precisionSearchHint: FieldValue.delete() });
    }
  }

  log(
    `  hints: ${hintsRemoved.length} from the Partner/amount strategies ` +
      `${opts.apply ? "removed" : "to remove (dry run, nothing written)"}, ` +
      `${hintsKept} from the email strategies kept, ${filesSnap.size} Files scanned`,
  );

  return {
    filesScanned: filesSnap.size,
    hintsRemoved,
    hintsKept,
    connectionsToReview,
    listPath,
    backupPath,
  };
}
