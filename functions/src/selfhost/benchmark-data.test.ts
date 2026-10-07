/**
 * The shared benchmark data (docs/benchmarking.md): who is in it, building a
 * version, verifying it, and who may take it.
 */

process.env.FIBUKI_STORAGE = "memory";

import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";
import { getStorage } from "./storage-shim";

// REAL application code, unmodified:
import {
  benchmarkAccounts,
  buildVersion,
  deleteVersion,
  listVersions,
  setMember,
  storagePathOf,
  verifyBundle,
} from "../benchmark/benchmarkData";
import { apiKeyOwner, downloadBenchmarkVersion, listDownloadableVersions } from "../benchmark/download";
import { setBenchmarkMemberCallable, buildBenchmarkVersionCallable } from "../benchmark/benchmarkCallables";

const db = getFirestore();
const ADMIN = "bench-admin";
const FELIX = "bench-felix";
const STEFAN = "bench-stefan";
const DAY = Timestamp.fromDate(new Date());
const labels: Record<string, string> = { [FELIX]: "Felix", [STEFAN]: "Stefan" };
const labelOf = async (uid: string) => labels[uid] ?? uid;

async function seedAccount(uid: string) {
  await db.collection("transactions").doc(`${uid}-t1`).set({ userId: uid, amount: -1000, date: DAY, name: "Hetzner", fileIds: [] });
  await db.collection("files").doc(`${uid}-f1`).set({ userId: uid, fileName: "inv.pdf", extractedAmount: 1000, extractedDate: DAY, transactionIds: [] });
}

type Callable = { run: (req: unknown) => Promise<unknown> };
const asAdmin = { uid: ADMIN, token: { admin: true } };
const asUser = { uid: FELIX, token: {} };

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
  await seedAccount(FELIX);
  await seedAccount(STEFAN);
});

describe("who is in the benchmark", () => {
  it("an account joins only with the agreement that allows it", async () => {
    await expect(setMember(db, ADMIN, { targetUid: FELIX, inBenchmark: true })).rejects.toThrow(/contractNote/);
    const member = await setMember(db, ADMIN, { targetUid: FELIX, inBenchmark: true, contractNote: "Contract of 2026-10-07" });
    expect(member).toMatchObject({ inBenchmark: true, contractNote: "Contract of 2026-10-07", consentSetBy: ADMIN });
    expect(await benchmarkAccounts(db, labelOf)).toEqual([{ uid: FELIX, label: "Felix" }]);
  });

  it("only an admin sets the switches", async () => {
    await expect(
      (setBenchmarkMemberCallable as unknown as Callable).run({ data: { targetUid: STEFAN, mayDownload: true }, auth: asUser })
    ).rejects.toThrow(/Admin access required/);
    await expect(
      (buildBenchmarkVersionCallable as unknown as Callable).run({ data: {}, auth: asUser })
    ).rejects.toThrow(/Admin access required/);
    const result = (await (setBenchmarkMemberCallable as unknown as Callable).run({
      data: { targetUid: STEFAN, mayDownload: true },
      auth: asAdmin,
    })) as { member: { mayDownload: boolean } };
    expect(result.member.mayDownload).toBe(true);
  });
});

describe("a version", () => {
  beforeEach(async () => {
    await setMember(db, ADMIN, { targetUid: FELIX, inBenchmark: true, contractNote: "Contract A" });
    await setMember(db, ADMIN, { targetUid: STEFAN, inBenchmark: true, contractNote: "Contract B" });
  });

  it("holds every account in the benchmark, verifiable by its checksum", async () => {
    const summary = await buildVersion(db, ADMIN, labelOf, { now: () => new Date("2026-10-07T10:00:00Z") });
    expect(summary.version).toBe("bench-2026-10");
    expect(summary.accounts.map((a) => a.label)).toEqual(["Felix", "Stefan"]);

    const [bytes] = await getStorage().bucket().file(storagePathOf("bench-2026-10")).download();
    const bundle = verifyBundle(JSON.parse(bytes.toString()));
    expect(bundle.checksum).toBe(summary.checksum);
    expect(bundle.accounts.map((a) => a.userId).sort()).toEqual([FELIX, STEFAN]);

    const tampered = JSON.parse(bytes.toString());
    tampered.accounts[0].collections.transactions[0].data.amount = -1;
    expect(() => verifyBundle(tampered)).toThrow(/checksum mismatch/);
  });

  it("a second version in the month gets its own name; delete removes it", async () => {
    const now = () => new Date("2026-10-07T10:00:00Z");
    await buildVersion(db, ADMIN, labelOf, { now });
    const second = await buildVersion(db, ADMIN, labelOf, { now });
    expect(second.version).toBe("bench-2026-10-2");
    await deleteVersion(db, "bench-2026-10");
    expect((await listVersions(db)).map((v) => v.version)).toEqual(["bench-2026-10-2"]);
  });

  it("counts the hand decisions made since the newest version", async () => {
    await buildVersion(db, ADMIN, labelOf, { now: () => new Date(Date.now() - 60_000) });
    expect((await listVersions(db))[0].newHandDecisions).toBe(0);
    await db.collection("fileConnections").add({ userId: FELIX, fileId: `${FELIX}-f1`, transactionId: `${FELIX}-t1`, connectionType: "manual", createdAt: Timestamp.now() });
    await db.collection("fileConnections").add({ userId: FELIX, fileId: "x", transactionId: "y", connectionType: "auto_matched", createdAt: Timestamp.now() });
    expect((await listVersions(db))[0].newHandDecisions).toBe(1);
  });
});

describe("taking a version", () => {
  beforeEach(async () => {
    await setMember(db, ADMIN, { targetUid: FELIX, inBenchmark: true, contractNote: "Contract A" });
    await buildVersion(db, ADMIN, labelOf, { now: () => new Date("2026-10-07T10:00:00Z") });
  });

  it("is refused without the switch, and logged with it", async () => {
    const bucket = getStorage().bucket();
    expect(await downloadBenchmarkVersion(db, bucket, STEFAN, "bench-2026-10", "login")).toMatchObject({ ok: false, status: 403 });
    expect(await listDownloadableVersions(db, STEFAN)).toBeNull();

    await setMember(db, ADMIN, { targetUid: STEFAN, mayDownload: true });
    const outcome = await downloadBenchmarkVersion(db, bucket, STEFAN, "bench-2026-10", "apiKey");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(verifyBundle(JSON.parse(outcome.bytes.toString())).version).toBe("bench-2026-10");
    expect(await downloadBenchmarkVersion(db, bucket, STEFAN, "../../etc/passwd", "login")).toMatchObject({ ok: false, status: 404 });

    const log = await db.collection("benchmarkDownloads").get();
    expect(log.docs.map((d) => d.data())).toEqual([expect.objectContaining({ uid: STEFAN, version: "bench-2026-10", via: "apiKey" })]);
  });

  it("a personal API key names its owner until it is revoked", async () => {
    const key = "fk_test_benchmark_key";
    const hash = createHash("sha256").update(key).digest("hex");
    const ref = await db.collection("apiKeys").add({ userId: STEFAN, keyHash: hash, revokedAt: null, expiresAt: null });
    expect(await apiKeyOwner(db, key)).toBe(STEFAN);
    expect(await apiKeyOwner(db, "fk_wrong")).toBeNull();
    await ref.update({ revokedAt: Timestamp.now() });
    expect(await apiKeyOwner(db, key)).toBeNull();
  });
});
