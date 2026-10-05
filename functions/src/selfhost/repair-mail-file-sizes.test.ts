/**
 * #722: the repair sets a mail-imported File's size from its stored object,
 * reports how many it changed, and touches nothing else. Run against the
 * Postgres-backed shim and the in-memory blob store.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { getFirestore, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { getStorage, _resetStorageForTests } from "./storage-shim";
import { repairMailFileSizes } from "./repair-mail-file-sizes";

const db = getFirestore();
const silent = () => {};

async function file(id: string) {
  return (await db.collection("files").doc(id).get()).data()!;
}

async function stored(storagePath: string, bytes: number) {
  await getStorage().bucket().file(storagePath).save(Buffer.alloc(bytes, 0x25));
}

async function apply(extra: { userId?: string } = {}) {
  const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "mail-file-sizes-"));
  return repairMailFileSizes({ apply: true, backupDir, log: silent, ...extra });
}

const prevStorage = process.env.FIBUKI_STORAGE;

beforeEach(async () => {
  process.env.FIBUKI_STORAGE = "memory";
  _resetStorageForTests();
  await __whenShimIdle();
  await __resetFirestoreShim();
});

afterAll(() => {
  if (prevStorage === undefined) delete process.env.FIBUKI_STORAGE;
  else process.env.FIBUKI_STORAGE = prevStorage;
  _resetStorageForTests();
});

describe("repairMailFileSizes", () => {
  it("sets the size from the stored object and changes nothing else", async () => {
    await stored("files/u1/a.pdf", 3000);
    const before = {
      userId: "u1",
      sourceType: "gmail",
      storagePath: "files/u1/a.pdf",
      fileName: "a.pdf",
      fileSize: 4104,
      extractionComplete: true,
    };
    await db.collection("files").doc("f1").set(before);

    const report = await apply();

    expect(report.changed).toEqual([{ id: "f1", from: 4104, to: 3000 }]);
    expect(await file("f1")).toEqual({ ...before, fileSize: 3000 });
  });

  it("is a dry run by default", async () => {
    await stored("files/u1/a.pdf", 3000);
    await db.collection("files").doc("f1").set({
      userId: "u1", sourceType: "gmail", storagePath: "files/u1/a.pdf", fileSize: 4104,
    });

    const report = await repairMailFileSizes({ log: silent });

    expect(report.changed).toHaveLength(1);
    expect(report.applied).toBe(false);
    expect((await file("f1")).fileSize).toBe(4104);
  });

  it("leaves a File that already records its stored size, so a second run changes nothing", async () => {
    await stored("files/u1/a.pdf", 3000);
    await db.collection("files").doc("f1").set({
      userId: "u1", sourceType: "gmail", storagePath: "files/u1/a.pdf", fileSize: 4104,
    });

    expect((await apply()).changed).toHaveLength(1);
    const second = await apply();
    expect(second.changed).toEqual([]);
    expect(second.backupPath).toBeNull();
  });

  it("only reads mail-imported Files", async () => {
    await stored("files/u1/up.pdf", 3000);
    await db.collection("files").doc("upload").set({
      userId: "u1", sourceType: "upload", storagePath: "files/u1/up.pdf", fileSize: 9999,
    });

    const report = await apply();

    expect(report.filesScanned).toBe(0);
    expect((await file("upload")).fileSize).toBe(9999);
  });

  it("reports a File with no stored object and leaves it as stored", async () => {
    await db.collection("files").doc("purged").set({
      userId: "u1", sourceType: "gmail", storagePath: "files/u1/gone.pdf", fileSize: 4104,
    });

    const report = await apply();

    expect(report.missing).toEqual(["purged"]);
    expect(report.changed).toEqual([]);
    expect((await file("purged")).fileSize).toBe(4104);
  });

  it("limits the pass to one tenant", async () => {
    await stored("files/u1/a.pdf", 3000);
    await stored("files/u2/b.pdf", 3000);
    await db.collection("files").doc("f1").set({
      userId: "u1", sourceType: "gmail", storagePath: "files/u1/a.pdf", fileSize: 4104,
    });
    await db.collection("files").doc("f2").set({
      userId: "u2", sourceType: "gmail", storagePath: "files/u2/b.pdf", fileSize: 4104,
    });

    const report = await apply({ userId: "u1" });

    expect(report.changed.map((c) => c.id)).toEqual(["f1"]);
    expect((await file("f2")).fileSize).toBe(4104);
  });

  it("writes a backup of the sizes it replaces before writing", async () => {
    await stored("files/u1/a.pdf", 3000);
    await db.collection("files").doc("f1").set({
      userId: "u1", sourceType: "gmail", storagePath: "files/u1/a.pdf", fileSize: 4104,
    });

    const report = await apply();

    const backup = JSON.parse(await fs.readFile(report.backupPath!, "utf8"));
    expect(backup).toEqual([{ id: "f1", fileSize: 4104 }]);
  });
});
