/**
 * A Replay Set: one User's matching inputs, frozen to a JSON file.
 *
 * The before/after replay (docs/replay.md) runs the matcher over the same
 * data twice, on `main` and on a branch, and diffs what it would decide. The
 * data is a real account, read once from the deployment's database and never
 * written back; the sheet is built on an embedded PGlite that this file fills
 * from the set. So a set is private data: it holds the account's bank lines
 * and extracted documents. It is kept out of the repo (`*.replay-set.json`
 * is gitignored) and shared only between the people whose accounts it holds.
 *
 * What goes in is what the one matcher (#613) and the Partner matcher read:
 * the User's Transactions, Files, Partners, File Connections and Invoices,
 * every active Global Partner, and the ECB reference-rate months. Nothing
 * else: no mail, no API keys, no chat. `extractedText` is dropped unless
 * asked for, because the matcher never reads it and it is the bulk of a File.
 *
 * Values travel in the dump wire format (`{ __ts: [s, n] }` for a Timestamp),
 * the same one the W3 migration dump speaks.
 */

import { serializeDocData, type DocLine } from "../selfhost/dump-format";
import { decodeWire } from "../selfhost/wire-values";

type Db = FirebaseFirestore.Firestore;

export const REPLAY_SET_VERSION = 1;

/** Collections a set carries, in the order they are loaded. */
export const REPLAY_COLLECTIONS = [
  "globalPartners",
  "fxReferenceRates",
  "partners",
  "transactions",
  "files",
  "fileConnections",
  "invoices",
] as const;

export type ReplayCollection = (typeof REPLAY_COLLECTIONS)[number];

export interface ReplaySet {
  version: typeof REPLAY_SET_VERSION;
  userId: string;
  /** Who the account belongs to, for the report header. Free text. */
  label: string;
  exportedAt: string;
  collections: Record<ReplayCollection, DocLine[]>;
}

export interface ExportReplaySetOptions {
  label?: string;
  /** Keep each File's `extractedText`. Off by default: large and never scored. */
  keepText?: boolean;
  /**
   * Only the most recent months: a Transaction dated inside them, a File
   * whose document date is inside them (an undated File by its upload). The
   * window starts on the first day of the month `months` months ago, so a
   * run on the 3rd and a run on the 28th cover the same calendar months.
   * Everything else (Partners, Connections, Invoices) is taken whole; it is
   * small, and a Connection outside the window is what the Remainder reads.
   */
  months?: number;
  now?: () => Date;
}

/** The window's first day as the stored dates are written: UTC midnight. */
export function monthsWindowStart(months: number, now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1));
}

function dateOf(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (value && typeof value === "object" && typeof (value as { toDate?: unknown }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate();
  }
  return null;
}

function insideWindow(value: unknown, start: Date): boolean {
  const date = dateOf(value);
  return date !== null && date.getTime() >= start.getTime();
}

/** Collections scoped to the User; the others are deployment-wide. */
const USER_SCOPED: ReadonlySet<ReplayCollection> = new Set<ReplayCollection>([
  "partners",
  "transactions",
  "files",
  "fileConnections",
  "invoices",
]);

async function readCollection(
  db: Db,
  name: ReplayCollection,
  userId: string,
  keep: (data: Record<string, unknown>) => boolean = () => true
): Promise<DocLine[]> {
  let query: FirebaseFirestore.Query = db.collection(name);
  if (USER_SCOPED.has(name)) query = query.where("userId", "==", userId);
  else if (name === "globalPartners") query = query.where("isActive", "==", true);
  const snapshot = await query.get();
  return snapshot.docs
    .filter((doc) => keep(doc.data() ?? {}))
    .map((doc) => ({ id: doc.id, data: serializeDocData(doc.data() ?? {}) }));
}

/** Read one User's matching inputs. Reads only. */
export async function exportReplaySet(
  db: Db,
  userId: string,
  options: ExportReplaySetOptions = {}
): Promise<ReplaySet> {
  const now = options.now ?? (() => new Date());
  const start = options.months != null ? monthsWindowStart(options.months, now()) : null;
  const keepTransaction = (data: Record<string, unknown>) => start === null || insideWindow(data.date, start);
  const keepFile = (data: Record<string, unknown>) => {
    if (start === null) return true;
    if (dateOf(data.extractedDate)) return insideWindow(data.extractedDate, start);
    return insideWindow(data.createdAt, start) || insideWindow(data.uploadedAt, start);
  };

  const collections = {} as Record<ReplayCollection, DocLine[]>;
  for (const name of REPLAY_COLLECTIONS) {
    const keep = name === "transactions" ? keepTransaction : name === "files" ? keepFile : undefined;
    collections[name] = await readCollection(db, name, userId, keep);
  }
  if (!options.keepText) {
    for (const line of collections.files) delete line.data.extractedText;
  }
  return {
    version: REPLAY_SET_VERSION,
    userId,
    label: options.label ?? userId,
    exportedAt: now().toISOString(),
    collections,
  };
}

export function parseReplaySet(json: unknown): ReplaySet {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("replay set: not a JSON object");
  }
  const set = json as Partial<ReplaySet>;
  if (set.version !== REPLAY_SET_VERSION) {
    throw new Error(`replay set: unsupported version ${JSON.stringify(set.version)}`);
  }
  if (typeof set.userId !== "string" || !set.userId) throw new Error("replay set: userId missing");
  if (typeof set.collections !== "object" || set.collections === null) {
    throw new Error("replay set: collections missing");
  }
  for (const name of REPLAY_COLLECTIONS) {
    const lines = (set.collections as Record<string, unknown>)[name];
    if (!Array.isArray(lines)) throw new Error(`replay set: collection ${name} missing`);
  }
  return set as ReplaySet;
}

/**
 * Write a set into a database, document by document. Meant for an empty
 * embedded database only: the sheet builder refuses to run against a
 * configured DATABASE_URL, so a set can never land in a deployment.
 */
export async function loadReplaySet(db: Db, set: ReplaySet): Promise<void> {
  for (const name of REPLAY_COLLECTIONS) {
    const collection = db.collection(name);
    for (const line of set.collections[name]) {
      await collection.doc(line.id).set(decodeWire(line.data, false) as Record<string, unknown>);
    }
  }
}

export function replaySetCounts(set: ReplaySet): Record<ReplayCollection, number> {
  const out = {} as Record<ReplayCollection, number>;
  for (const name of REPLAY_COLLECTIONS) out[name] = set.collections[name].length;
  return out;
}
