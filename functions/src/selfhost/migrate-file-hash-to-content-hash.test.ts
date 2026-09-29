/**
 * #328: Files written by the two Gmail routes carry their digest as `fileHash`,
 * which the write point's duplicate lookup cannot see. The backfill moves it
 * to `contentHash`, run against the real Postgres-backed shim.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { getFirestore, __resetFirestoreShim } from "./firestore-shim";
import { migrateFileHashToContentHash } from "./migrate-file-hash-to-content-hash";

const db = getFirestore();
const silent = () => {};

async function file(id: string) {
  return (await db.collection("files").doc(id).get()).data()!;
}

async function apply(extra: { userId?: string } = {}) {
  const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-hash-"));
  return migrateFileHashToContentHash({ apply: true, backupDir, log: silent, ...extra });
}

beforeEach(async () => {
  await __resetFirestoreShim();
});

describe("migrateFileHashToContentHash", () => {
  it("moves fileHash to contentHash and drops the old field", async () => {
    await db.collection("files").doc("f1").set({ userId: "u1", fileHash: "abc" });

    const report = await apply();

    expect(report.moved).toEqual(["f1"]);
    const after = await file("f1");
    expect(after.contentHash).toBe("abc");
    expect(after.fileHash).toBeUndefined();
  });

  it("is a dry run by default", async () => {
    await db.collection("files").doc("f1").set({ userId: "u1", fileHash: "abc" });

    const report = await migrateFileHashToContentHash({ log: silent });

    expect(report.moved).toEqual(["f1"]);
    expect(report.applied).toBe(false);
    expect((await file("f1")).fileHash).toBe("abc");
  });

  it("keeps an existing contentHash and only drops the old field", async () => {
    await db.collection("files").doc("f1").set({ userId: "u1", fileHash: "abc", contentHash: "abc" });

    const report = await apply();

    expect(report.moved).toEqual([]);
    expect(report.dropped).toEqual(["f1"]);
    const after = await file("f1");
    expect(after.contentHash).toBe("abc");
    expect(after.fileHash).toBeUndefined();
  });

  it("leaves a File alone when the two digests disagree, and reports it", async () => {
    await db.collection("files").doc("f1").set({ userId: "u1", fileHash: "abc", contentHash: "xyz" });

    const report = await apply();

    expect(report.conflicts).toEqual([{ id: "f1", fileHash: "abc", contentHash: "xyz" }]);
    expect((await file("f1")).fileHash).toBe("abc");
  });

  it("reports Files that turn out to be byte copies of each other, without merging them", async () => {
    await db.collection("files").doc("gmail").set({ userId: "u1", fileHash: "abc" });
    await db.collection("files").doc("upload").set({ userId: "u1", contentHash: "abc" });
    await db.collection("files").doc("other-user").set({ userId: "u2", contentHash: "abc" });

    const report = await apply();

    expect(report.duplicates).toEqual([{ userId: "u1", contentHash: "abc", ids: ["gmail", "upload"] }]);
    expect(await file("upload")).toBeDefined();
  });

  it("limits the pass to one tenant", async () => {
    await db.collection("files").doc("f1").set({ userId: "u1", fileHash: "abc" });
    await db.collection("files").doc("f2").set({ userId: "u2", fileHash: "def" });

    const report = await apply({ userId: "u1" });

    expect(report.moved).toEqual(["f1"]);
    expect((await file("f2")).fileHash).toBe("def");
  });

  it("writes a backup before changing anything", async () => {
    await db.collection("files").doc("f1").set({ userId: "u1", fileHash: "abc" });

    const report = await apply();

    const backup = JSON.parse(await fs.readFile(report.backupPath!, "utf8"));
    expect(backup).toEqual([{ id: "f1", fileHash: "abc", contentHash: null }]);
  });

  it("refuses to apply without a backup directory", async () => {
    await expect(migrateFileHashToContentHash({ apply: true, log: silent })).rejects.toThrow(/backupDir/);
  });
});
