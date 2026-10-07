/**
 * Handing a benchmark version to a person allowed to take it
 * (docs/benchmarking.md). Used by the web's download route, so it imports no
 * storage or callable module of its own: the caller passes the database and
 * the bucket its build resolves.
 *
 * Who is asking is settled once, here or by the caller: a login (the route
 * resolves the session) or a personal API key (an agent or a script). Either
 * way the person needs the "may download" switch, and every download is
 * logged with the version and how it was taken.
 */

import { createHash } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";

type Db = FirebaseFirestore.Firestore;
interface BucketLike {
  file(path: string): { download(): Promise<[Buffer]> };
}

const MEMBERS = "benchmarkMembers";
const VERSIONS = "benchmarkVersions";
const DOWNLOADS = "benchmarkDownloads";
const VERSION_ID = /^bench-[0-9]{4}-[0-9]{2}(-[0-9]+)?$/;

/**
 * The owner of a live personal API key, or null. The same rule as
 * api-keys/index.ts `validateApiKey`: the sha256 of the key, not revoked,
 * not expired.
 */
export async function apiKeyOwner(db: Db, key: string): Promise<string | null> {
  if (!key.startsWith("fk_")) return null;
  const hash = createHash("sha256").update(key).digest("hex");
  const snap = await db.collection("apiKeys").where("keyHash", "==", hash).where("revokedAt", "==", null).limit(1).get();
  if (snap.empty) return null;
  const data = snap.docs[0].data();
  const expires = data.expiresAt as Timestamp | null | undefined;
  if (expires && typeof expires.toDate === "function" && expires.toDate() < new Date()) return null;
  return typeof data.userId === "string" ? data.userId : null;
}

export type DownloadOutcome =
  | { ok: true; bytes: Buffer; version: string; checksum: string }
  | { ok: false; status: 403 | 404; error: string };

export async function downloadBenchmarkVersion(
  db: Db,
  bucket: BucketLike,
  uid: string,
  versionId: string,
  via: "login" | "apiKey"
): Promise<DownloadOutcome> {
  const member = (await db.collection(MEMBERS).doc(uid).get()).data();
  if (member?.mayDownload !== true) {
    return { ok: false, status: 403, error: "You may not download benchmark data. An admin grants it in user management." };
  }
  if (!VERSION_ID.test(versionId)) return { ok: false, status: 404, error: "No such version" };
  const snap = await db.collection(VERSIONS).doc(versionId).get();
  if (!snap.exists || snap.data()?.deletedAt) return { ok: false, status: 404, error: "No such version" };
  const data = snap.data()!;
  const [bytes] = await bucket.file(data.storagePath as string).download();
  await db.collection(DOWNLOADS).add({ uid, version: data.version, checksum: data.checksum, via, at: Timestamp.now() });
  return { ok: true, bytes, version: data.version as string, checksum: data.checksum as string };
}

/** The versions a person who may download can see: name, date, size, checksum. */
export async function listDownloadableVersions(
  db: Db,
  uid: string
): Promise<Array<{ version: string; builtAt: string; sizeBytes: number; checksum: string }> | null> {
  const member = (await db.collection(MEMBERS).doc(uid).get()).data();
  if (member?.mayDownload !== true) return null;
  const snap = await db.collection(VERSIONS).get();
  return snap.docs
    .map((d) => d.data())
    .filter((d) => !d.deletedAt)
    .map((d) => ({ version: d.version as string, builtAt: d.builtAt as string, sizeBytes: d.sizeBytes as number, checksum: d.checksum as string }))
    .sort((a, b) => b.builtAt.localeCompare(a.builtAt));
}
