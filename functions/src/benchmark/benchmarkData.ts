/**
 * The shared benchmark data (docs/benchmarking.md, roadmap item 5).
 *
 * Which accounts are in the benchmark, who may download it, and the frozen,
 * versioned snapshots built from them. An admin opts an account in, with a
 * contract note that is the consent record. A version is one JSON file of
 * the opted-in accounts' Replay Sets (functions/src/replay/set.ts), stored in
 * the bucket with a checksum, so every developer runs on exactly the same
 * data and a scorecard names the version and checksum it ran on.
 *
 * Collections, all server-only (data-policy.ts):
 *   benchmarkMembers/{uid}     the two flags and who set them
 *   benchmarkVersions/{id}     one per built version
 *   benchmarkDownloads/{auto}  who took which version, and how
 */

import { createHash } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { exportReplaySet, replaySetCounts, type ReplaySet } from "../replay/set";

type Db = FirebaseFirestore.Firestore;

export const MEMBERS = "benchmarkMembers";
export const VERSIONS = "benchmarkVersions";
export const DOWNLOADS = "benchmarkDownloads";

/** Months of each account a version takes, as the replay does. */
export const BENCHMARK_MONTHS = 12;

export const BUNDLE_FORMAT = "fibuki-benchmark";
export const BUNDLE_FORMAT_VERSION = 1;

export interface BenchmarkMember {
  uid: string;
  inBenchmark: boolean;
  /** The agreement that allows it, e.g. "Contract of 2026-10-07". Required to opt in. */
  contractNote: string | null;
  consentSetAt: Timestamp | null;
  consentSetBy: string | null;
  mayDownload: boolean;
  downloadSetAt: Timestamp | null;
  downloadSetBy: string | null;
}

export interface BenchmarkBundle {
  format: typeof BUNDLE_FORMAT;
  formatVersion: typeof BUNDLE_FORMAT_VERSION;
  /** e.g. bench-2026-10, bench-2026-10-2 for the second of a month */
  version: string;
  builtAt: string;
  months: number;
  /** sha256 of JSON.stringify(accounts): what `bench verify` recomputes. */
  checksum: string;
  accounts: ReplaySet[];
}

export interface BenchmarkVersionSummary {
  id: string;
  version: string;
  builtAt: string;
  builtBy: string;
  checksum: string;
  sizeBytes: number;
  months: number;
  accounts: Array<{ uid: string; label: string; transactions: number; files: number }>;
  /** Hand connections made or confirmed in the member accounts since this version was built. */
  newHandDecisions?: number;
}

export function storagePathOf(version: string): string {
  return `benchmark/${version}.json`;
}

export function checksumOf(accounts: ReplaySet[]): string {
  return createHash("sha256").update(JSON.stringify(accounts)).digest("hex");
}

/** Throws when the bundle is not one, or its accounts are not what its checksum says. */
export function verifyBundle(json: unknown): BenchmarkBundle {
  const bundle = json as Partial<BenchmarkBundle> | null;
  if (!bundle || bundle.format !== BUNDLE_FORMAT || bundle.formatVersion !== BUNDLE_FORMAT_VERSION) {
    throw new Error("not a FiBuKI benchmark version (format or formatVersion)");
  }
  if (!Array.isArray(bundle.accounts) || typeof bundle.checksum !== "string") {
    throw new Error("benchmark version: accounts or checksum missing");
  }
  const actual = checksumOf(bundle.accounts);
  if (actual !== bundle.checksum) {
    throw new Error(`benchmark version ${bundle.version}: checksum mismatch, the file was changed (${actual.slice(0, 12)} != ${bundle.checksum.slice(0, 12)})`);
  }
  return bundle as BenchmarkBundle;
}

// ============================================================================
// Members
// ============================================================================

function memberOf(uid: string, data: FirebaseFirestore.DocumentData | undefined): BenchmarkMember {
  return {
    uid,
    inBenchmark: data?.inBenchmark === true,
    contractNote: (data?.contractNote as string | undefined) ?? null,
    consentSetAt: (data?.consentSetAt as Timestamp | undefined) ?? null,
    consentSetBy: (data?.consentSetBy as string | undefined) ?? null,
    mayDownload: data?.mayDownload === true,
    downloadSetAt: (data?.downloadSetAt as Timestamp | undefined) ?? null,
    downloadSetBy: (data?.downloadSetBy as string | undefined) ?? null,
  };
}

export async function readMembers(db: Db, uids: string[]): Promise<Map<string, BenchmarkMember>> {
  const out = new Map<string, BenchmarkMember>();
  if (uids.length === 0) return out;
  const snaps = await db.getAll(...uids.map((uid) => db.collection(MEMBERS).doc(uid)));
  for (const snap of snaps) out.set(snap.id, memberOf(snap.id, snap.exists ? snap.data() : undefined));
  return out;
}

export async function readMember(db: Db, uid: string): Promise<BenchmarkMember> {
  const snap = await db.collection(MEMBERS).doc(uid).get();
  return memberOf(uid, snap.exists ? snap.data() : undefined);
}

export interface SetMemberRequest {
  targetUid: string;
  inBenchmark?: boolean;
  contractNote?: string | null;
  mayDownload?: boolean;
}

/** An admin sets either flag. Opting an account in needs the contract note. */
export async function setMember(db: Db, adminUid: string, request: SetMemberRequest): Promise<BenchmarkMember> {
  const { targetUid } = request;
  if (typeof targetUid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(targetUid)) {
    throw new Error("invalid-argument: targetUid");
  }
  const ref = db.collection(MEMBERS).doc(targetUid);
  const current = memberOf(targetUid, (await ref.get()).data());
  const now = Timestamp.now();
  const update: Record<string, unknown> = { uid: targetUid };

  if (request.inBenchmark !== undefined) {
    const note = (request.contractNote ?? current.contractNote ?? "").trim();
    if (request.inBenchmark && !note) {
      throw new Error("invalid-argument: an account joins the benchmark only with the contract that allows it (contractNote)");
    }
    update.inBenchmark = request.inBenchmark === true;
    update.contractNote = note || null;
    update.consentSetAt = now;
    update.consentSetBy = adminUid;
  } else if (request.contractNote !== undefined) {
    update.contractNote = (request.contractNote ?? "").trim() || null;
  }
  if (request.mayDownload !== undefined) {
    update.mayDownload = request.mayDownload === true;
    update.downloadSetAt = now;
    update.downloadSetBy = adminUid;
  }
  await ref.set(update, { merge: true });
  return memberOf(targetUid, { ...current, ...update });
}

/** The accounts in the benchmark, with a label for reports. */
export async function benchmarkAccounts(
  db: Db,
  labelOf: (uid: string) => Promise<string>
): Promise<Array<{ uid: string; label: string }>> {
  const snap = await db.collection(MEMBERS).where("inBenchmark", "==", true).get();
  const out: Array<{ uid: string; label: string }> = [];
  for (const doc of snap.docs) out.push({ uid: doc.id, label: await labelOf(doc.id) });
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

// ============================================================================
// Versions
// ============================================================================

async function nextVersionName(db: Db, now: Date): Promise<string> {
  const base = `bench-${now.toISOString().slice(0, 7)}`;
  const taken = new Set((await db.collection(VERSIONS).get()).docs.map((d) => d.data().version as string));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** Export every opted-in account, store the bundle, record the version. Reads accounts only. */
export async function buildVersion(
  db: Db,
  adminUid: string,
  labelOf: (uid: string) => Promise<string>,
  options: { now?: () => Date } = {}
): Promise<BenchmarkVersionSummary> {
  const now = options.now ?? (() => new Date());
  const members = await benchmarkAccounts(db, labelOf);
  if (members.length === 0) throw new Error("failed-precondition: no account is in the benchmark yet");

  const accounts: ReplaySet[] = [];
  for (const m of members) {
    accounts.push(await exportReplaySet(db, m.uid, { label: m.label, months: BENCHMARK_MONTHS, now }));
  }
  const builtAt = now();
  const version = await nextVersionName(db, builtAt);
  const bundle: BenchmarkBundle = {
    format: BUNDLE_FORMAT,
    formatVersion: BUNDLE_FORMAT_VERSION,
    version,
    builtAt: builtAt.toISOString(),
    months: BENCHMARK_MONTHS,
    checksum: checksumOf(accounts),
    accounts,
  };
  const bytes = Buffer.from(JSON.stringify(bundle));
  await getStorage().bucket().file(storagePathOf(version)).save(bytes, { contentType: "application/json" });

  const summary: Omit<BenchmarkVersionSummary, "id"> = {
    version,
    builtAt: bundle.builtAt,
    builtBy: adminUid,
    checksum: bundle.checksum,
    sizeBytes: bytes.length,
    months: BENCHMARK_MONTHS,
    accounts: accounts.map((set) => {
      const counts = replaySetCounts(set);
      return { uid: set.userId, label: set.label, transactions: counts.transactions, files: counts.files };
    }),
  };
  const ref = db.collection(VERSIONS).doc(version);
  await ref.set({ ...summary, builtAtTs: Timestamp.fromDate(builtAt), storagePath: storagePathOf(version), deletedAt: null });
  return { id: ref.id, ...summary };
}

/** Live versions, newest first; the newest says how many hand decisions came since. */
export async function listVersions(db: Db): Promise<BenchmarkVersionSummary[]> {
  const snap = await db.collection(VERSIONS).get();
  const live = snap.docs
    .filter((d) => !d.data().deletedAt)
    .map((d) => {
      const data = d.data();
      return {
        id: d.id,
        version: data.version,
        builtAt: data.builtAt,
        builtBy: data.builtBy,
        checksum: data.checksum,
        sizeBytes: data.sizeBytes,
        months: data.months,
        accounts: data.accounts ?? [],
      } as BenchmarkVersionSummary;
    })
    .sort((a, b) => b.builtAt.localeCompare(a.builtAt));
  if (live.length > 0) live[0].newHandDecisions = await handDecisionsSince(db, live[0]);
  return live;
}

/**
 * Hand connections made, or automatic ones confirmed, in the version's
 * accounts since it was built: the sign a new version is worth cutting.
 */
async function handDecisionsSince(db: Db, version: BenchmarkVersionSummary): Promise<number> {
  const since = new Date(version.builtAt);
  let count = 0;
  for (const account of version.accounts) {
    const snap = await db.collection("fileConnections").where("userId", "==", account.uid).get();
    for (const doc of snap.docs) {
      const data = doc.data();
      const type = data.connectionType as string;
      if (type === "auto_matched" || type === "ai_matched") continue;
      const at = (data.confirmedAt ?? data.createdAt) as Timestamp | undefined;
      if (at && typeof at.toDate === "function" && at.toDate() > since) count++;
    }
  }
  return count;
}

export async function deleteVersion(db: Db, versionId: string): Promise<void> {
  const ref = db.collection(VERSIONS).doc(versionId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.deletedAt) throw new Error("not-found: no such version");
  try {
    await getStorage().bucket().file(snap.data()!.storagePath as string).delete();
  } catch {
    // Already gone from the bucket: the record still goes.
  }
  await ref.update({ deletedAt: Timestamp.now() });
}
