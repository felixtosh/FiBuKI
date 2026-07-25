/**
 * W3 migration dump — exporter unit suite (chunk 1). Exercises exportDump()
 * directly against the existing shims, independent of migrate-import.ts
 * (which doesn't exist yet — the full round-trip acceptance tests in
 * migrate-import.test.ts / migrate-import-storage.test.ts stay xfail until
 * that lands). These tests read the dump directory back off disk by hand
 * to prove the NDJSON + manifest contents are correct on their own merits.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { getFirestore, Timestamp } from "./firestore-shim";
import { getAuth } from "./auth-shim";
import { createSelfhostAuth } from "./better-auth";
import { getStorage, _resetStorageForTests } from "./storage-shim";
import { exportDump } from "./migrate-export";
import { parseManifest } from "./dump-format";

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
let seq = 0;
const uniqueEmail = (tag: string) => `xp-${tag}-${++seq}-${RUN}@example.test`;
const COLLECTION = `w3exportSpec${RUN}`;

async function makeDumpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "w3-export-"));
}

async function readNdjson(dir: string, file: string): Promise<Record<string, unknown>[]> {
  const body = await fs.readFile(path.join(dir, file), "utf8");
  return body
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("migrate-export — exportDump against the existing shims", () => {
  it("writes collection docs to NDJSON with Timestamps tagged, and a valid manifest", async () => {
    const docId = `doc-${RUN}`;
    await getFirestore()
      .collection(COLLECTION)
      .doc(docId)
      .set({
        name: "Röntgen & Söhne GmbH",
        amount: -42.9,
        paidAt: new Timestamp(1750001234, 40),
        tags: ["x", "y"],
      });

    const dir = await makeDumpDir();
    const manifest = await exportDump({ dir, firestore: getFirestore(), collections: [COLLECTION] });

    expect(manifest.version).toBe(1);
    const entry = manifest.collections.find((c) => c.path === COLLECTION);
    expect(entry?.count).toBe(1);

    const lines = await readNdjson(dir, path.join("collections", entry!.file));
    expect(lines).toHaveLength(1);
    expect(lines[0].id).toBe(docId);
    const data = lines[0].data as Record<string, unknown>;
    expect(data.name).toBe("Röntgen & Söhne GmbH");
    expect(data.amount).toBe(-42.9);
    expect(data.tags).toEqual(["x", "y"]);
    expect(data.paidAt).toEqual({ __ts: [1750001234, 40] });

    // manifest.json on disk round-trips through parseManifest cleanly.
    const onDisk: unknown = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"));
    expect(parseManifest(onDisk).collections[0].path).toBe(COLLECTION);
  });

  it("writes multiple docs across multiple collections, each to its own file", async () => {
    const otherCollection = `${COLLECTION}b`;
    await getFirestore().collection(COLLECTION).doc(`multi1-${RUN}`).set({ n: 1 });
    await getFirestore().collection(COLLECTION).doc(`multi2-${RUN}`).set({ n: 2 });
    await getFirestore().collection(otherCollection).doc(`multi3-${RUN}`).set({ n: 3 });

    const dir = await makeDumpDir();
    const manifest = await exportDump({
      dir,
      firestore: getFirestore(),
      collections: [COLLECTION, otherCollection],
    });

    const first = manifest.collections.find((c) => c.path === COLLECTION);
    const second = manifest.collections.find((c) => c.path === otherCollection);
    expect(first?.file).not.toBe(second?.file);
    expect(second?.count).toBe(1);

    const secondLines = await readNdjson(dir, path.join("collections", second!.file));
    expect(secondLines[0].id).toBe(`multi3-${RUN}`);
  });

  it("rejects opts.collections given without opts.firestore", async () => {
    const dir = await makeDumpDir();
    await expect(exportDump({ dir, collections: ["whatever"] })).rejects.toThrow();
  });

  it("returns null users/storage and an empty collections list when no handles are given", async () => {
    const dir = await makeDumpDir();
    const manifest = await exportDump({ dir });
    expect(manifest.collections).toEqual([]);
    expect(manifest.users).toBeNull();
    expect(manifest.storage).toBeNull();
  });

  it("writes users.ndjson with uid, email, displayName and admin claim preserved", async () => {
    const auth = await createSelfhostAuth();
    const adminEmail = uniqueEmail("admin");
    const plainEmail = uniqueEmail("plain");
    // Invite-only: provisionUser refuses emails absent from allowedEmails.
    await getFirestore().collection("allowedEmails").add({ email: adminEmail, createdAt: new Date() });
    await getFirestore().collection("allowedEmails").add({ email: plainEmail, createdAt: new Date() });
    const { uid: adminUid } = await auth.provisionUser({
      email: adminEmail,
      displayName: "Export Fixture Admin",
      admin: true,
    });
    const { uid: plainUid } = await auth.provisionUser({ email: plainEmail });

    const dir = await makeDumpDir();
    const manifest = await exportDump({ dir, auth: getAuth() });

    expect(manifest.users).not.toBeNull();
    const lines = await readNdjson(dir, manifest.users!.file);
    const adminLine = lines.find((l) => l.uid === adminUid);
    const plainLine = lines.find((l) => l.uid === plainUid);
    expect(adminLine).toBeDefined();
    expect(adminLine?.email).toBe(adminEmail);
    expect(adminLine?.displayName).toBe("Export Fixture Admin");
    expect(adminLine?.admin).toBe(true);
    expect(plainLine).toBeDefined();
    expect(plainLine?.email).toBe(plainEmail);
    expect(plainLine?.admin).toBeUndefined();
  });

  it("follows pageToken across multiple listUsers pages (no user left behind)", async () => {
    // A tenant larger than one page: exportUsers must follow pageToken until
    // it's exhausted, or users past the first page silently vanish from the
    // dump. Drive the loop with a paging mock; the real shim's token
    // generation is covered in better-auth.test.ts.
    const calls: (string | undefined)[] = [];
    const page1 = [
      { uid: "xp-pg-u1", email: "xp-pg-u1@example.test", providerData: [{ providerId: "password" }] },
      { uid: "xp-pg-u2", email: "xp-pg-u2@example.test", providerData: [{ providerId: "google.com" }] },
    ];
    const page2 = [{ uid: "xp-pg-u3", email: "xp-pg-u3@example.test", providerData: [] }];
    const auth = {
      listUsers: async (_max?: number, pageToken?: string) => {
        calls.push(pageToken);
        return pageToken ? { users: page2 } : { users: page1, pageToken: "PAGE-2" };
      },
    };

    const dir = await makeDumpDir();
    const manifest = await exportDump({ dir, auth });

    expect(calls).toEqual([undefined, "PAGE-2"]); // first page, then followed the token
    expect(manifest.users?.count).toBe(3);
    const lines = await readNdjson(dir, manifest.users!.file);
    expect(lines.map((l) => l.uid).sort()).toEqual(["xp-pg-u1", "xp-pg-u2", "xp-pg-u3"]);
  });
});

describe("migrate-export — storage", () => {
  let hadStorageEnv: string | undefined;
  let forcedMemory = false;

  beforeAll(() => {
    hadStorageEnv = process.env.FIBUKI_STORAGE;
    if (!process.env.FIBUKI_STORAGE && !process.env.FIBUKI_S3_ENDPOINT) {
      process.env.FIBUKI_STORAGE = "memory";
      forcedMemory = true;
      _resetStorageForTests();
    }
  });

  afterAll(() => {
    if (forcedMemory) {
      if (hadStorageEnv === undefined) delete process.env.FIBUKI_STORAGE;
      else process.env.FIBUKI_STORAGE = hadStorageEnv;
      _resetStorageForTests();
    }
  });

  it("writes objects to disk with a checksum-matching storage manifest", async () => {
    const prefix = `files/w3export${RUN}`;
    const objPath = `${prefix}/u1/Beleg Übernachtung.pdf`;
    const bytes = Buffer.from(`%PDF-1.4 export fixture ${RUN}`);
    const bucket = getStorage().bucket();
    await bucket.file(objPath).save(bytes, {
      contentType: "application/pdf",
      metadata: { metadata: { firebaseStorageDownloadTokens: "tok-export" } },
    });

    const dir = await makeDumpDir();
    const manifest = await exportDump({ dir, storage: bucket, storagePrefix: prefix });

    expect(manifest.storage?.count).toBe(1);
    expect(manifest.storage?.bytes).toBe(bytes.length);

    const written = await fs.readFile(path.join(dir, "objects", objPath));
    expect(written.equals(bytes)).toBe(true);

    const lines = await readNdjson(dir, manifest.storage!.manifest);
    expect(lines).toHaveLength(1);
    expect(lines[0].path).toBe(objPath);
    expect(lines[0].size).toBe(bytes.length);
    expect(lines[0].md5).toBe(createHash("md5").update(bytes).digest("hex"));
    expect(lines[0].contentType).toBe("application/pdf");
    expect((lines[0].metadata as Record<string, string>).firebaseStorageDownloadTokens).toBe("tok-export");
  });
});
