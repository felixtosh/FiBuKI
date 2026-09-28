/**
 * #266: the Partner name backfill runs against the real Postgres-backed shim,
 * so the tests prove what lands in the self-host store, not just what the
 * plan computes.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { getFirestore, __resetFirestoreShim } from "./firestore-shim";
import { decodePartnerNameEntities } from "./migrate-decode-partner-name-entities";

const db = getFirestore();
const silent = () => {};

async function tmpBackupDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "decode-partner-names-"));
}

async function partner(id: string) {
  return (await db.collection("partners").doc(id).get()).data()!;
}

async function apply(extra: { userId?: string } = {}) {
  return decodePartnerNameEntities({ apply: true, backupDir: await tmpBackupDir(), log: silent, ...extra });
}

beforeEach(async () => {
  await __resetFirestoreShim();
});

describe("decodePartnerNameEntities", () => {
  it("decodes a name and aliases holding character references", async () => {
    await db.collection("partners").doc("p1").set({
      userId: "u1",
      name: "AL&amp;FA Taxi KG",
      aliases: ["AL&#38;FA", "Plain Alias"],
    });

    const report = await apply();

    expect(report.changes).toEqual([
      {
        id: "p1",
        userId: "u1",
        before: { name: "AL&amp;FA Taxi KG", aliases: ["AL&#38;FA", "Plain Alias"] },
        after: { name: "AL&FA Taxi KG", aliases: ["AL&FA", "Plain Alias"] },
      },
    ]);
    const after = await partner("p1");
    expect(after.name).toBe("AL&FA Taxi KG");
    expect(after.aliases).toEqual(["AL&FA", "Plain Alias"]);
    expect(after.nameEntitiesDecodedAt).toBeDefined();
  });

  it("is a dry run by default: reports the change and writes nothing", async () => {
    await db.collection("partners").doc("p1").set({ userId: "u1", name: "AL&amp;FA Taxi KG", aliases: [] });

    const report = await decodePartnerNameEntities({ log: silent });

    expect(report.applied).toBe(false);
    expect(report.backupPath).toBeNull();
    expect(report.changes.map((c) => c.after.name)).toEqual(["AL&FA Taxi KG"]);
    const after = await partner("p1");
    expect(after.name).toBe("AL&amp;FA Taxi KG");
    expect(after.nameEntitiesDecodedAt).toBeUndefined();
  });

  it("leaves a name with no reference, bare ampersand included, byte-identical", async () => {
    await db.collection("partners").doc("p1").set({
      userId: "u1",
      name: "Q & A Solutions",
      aliases: ["AT&T", "Müller & Söhne"],
    });

    const report = await apply();

    expect(report.changes).toEqual([]);
    expect(report.backupPath).toBeNull();
    const after = await partner("p1");
    expect(after.name).toBe("Q & A Solutions");
    expect(after.aliases).toEqual(["AT&T", "Müller & Söhne"]);
    expect(after.nameEntitiesDecodedAt).toBeUndefined();
  });

  it("strips one layer from a double-encoded name, and a second run changes nothing", async () => {
    await db.collection("partners").doc("p1").set({ userId: "u1", name: "AL&amp;amp;FA Taxi KG", aliases: [] });

    const first = await apply();
    expect(first.changes).toHaveLength(1);
    expect((await partner("p1")).name).toBe("AL&amp;FA Taxi KG");

    const second = await apply();
    expect(second.changes).toEqual([]);
    expect(second.backupPath).toBeNull();
    expect((await partner("p1")).name).toBe("AL&amp;FA Taxi KG");
  });

  it("can be scoped to one tenant", async () => {
    await db.collection("partners").doc("mine").set({ userId: "u1", name: "AL&amp;FA", aliases: [] });
    await db.collection("partners").doc("theirs").set({ userId: "u2", name: "AL&amp;FA", aliases: [] });

    const report = await apply({ userId: "u1" });

    expect(report.partnersScanned).toBe(1);
    expect(report.changes.map((c) => c.id)).toEqual(["mine"]);
    expect((await partner("mine")).name).toBe("AL&FA");
    expect((await partner("theirs")).name).toBe("AL&amp;FA");
  });

  it("reports a decoded name that now duplicates another Partner of the same user", async () => {
    await db.collection("partners").doc("old").set({ userId: "u1", name: "AL&amp;FA Taxi KG", aliases: [] });
    await db.collection("partners").doc("new").set({ userId: "u1", name: "AL&FA Taxi KG", aliases: [] });
    await db.collection("partners").doc("other-user").set({ userId: "u2", name: "AL&FA Taxi KG", aliases: [] });

    const report = await decodePartnerNameEntities({ log: silent });

    expect(report.collisions).toEqual([{ id: "old", name: "AL&FA Taxi KG", otherIds: ["new"] }]);
  });

  it("reports a reference the decoder does not handle and leaves it as stored", async () => {
    await db.collection("partners").doc("p1").set({ userId: "u1", name: "Billwerk&nbsp;GmbH", aliases: [] });

    const report = await apply();

    expect(report.changes).toEqual([]);
    expect(report.unhandled).toEqual([{ id: "p1", values: ["Billwerk&nbsp;GmbH"] }]);
    expect((await partner("p1")).name).toBe("Billwerk&nbsp;GmbH");
  });

  it("backs up the pre-image before writing", async () => {
    await db.collection("partners").doc("p1").set({ userId: "u1", name: "AL&amp;FA", aliases: ["X &amp; Y"] });

    const report = await apply();

    const backup = JSON.parse(await fs.readFile(report.backupPath!, "utf8"));
    expect(backup).toEqual([{ id: "p1", name: "AL&amp;FA", aliases: ["X &amp; Y"] }]);
  });

  it("refuses to apply without a backup directory", async () => {
    await expect(decodePartnerNameEntities({ apply: true, log: silent })).rejects.toThrow(/backupDir/);
  });
});
