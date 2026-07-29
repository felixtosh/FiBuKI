/**
 * W3 (data + user migration) — importer acceptance suite. ⚠ EVERY test is
 * `it.fails` (xfail): the modules under test do not exist yet. The
 * implementation is DONE when `./dump-format`, `./migrate-export` and
 * `./migrate-import` exist, the `.fails` marks are removed, and the suite is
 * green — see handoffs/2026-07-22-w3-migration-impl.md.
 *
 * W3 per docs/phase-2-rip-the-shim.md (W2 collapsed in: two production
 * users, forced password reset accepted): one-shot, idempotent, resumable
 * importers, dry-runnable, with a verification gate before any cutover.
 *
 * The export/import split is forced by ops constraints: the exporter runs
 * where Firebase Admin credentials live and emits a self-contained DUMP
 * DIRECTORY; the importer runs against the selfhost stack and never touches
 * Firebase. The dump format is the contract between them.
 *
 * Dump directory layout (version 1):
 *
 *   manifest.json                    DumpManifest (see below)
 *   collections/<file>.ndjson        one DocLine per line, wire-encoded data
 *   users.ndjson                     one UserLine per line
 *   storage-manifest.ndjson          one StorageLine per line
 *   objects/<path...>                raw object bytes, Firebase paths verbatim
 *
 * The seams these tests define:
 *
 *   // functions/src/selfhost/dump-format.ts — PURE. No shim imports: the
 *   // creds-side exporter script loads this next to the REAL firebase-admin.
 *   export const DUMP_VERSION = 1;
 *   export interface DumpManifest {
 *     version: 1;
 *     exportedAt: string;            // ISO 8601, stamped by the exporter
 *     projectId?: string;
 *     collections: { path: string; file: string; count: number }[];
 *     users: { file: string; count: number } | null;
 *     storage: { manifest: string; objectsDir: string; count: number; bytes: number } | null;
 *   }
 *   export interface DocLine { id: string; data: Record<string, unknown> }
 *   export interface UserLine {
 *     uid: string; email: string; displayName?: string;
 *     admin?: boolean;               // from customClaims.admin
 *     providerIds: string[];         // e.g. ["password", "google.com"]
 *     disabled?: boolean;
 *   }
 *   export interface StorageLine {
 *     path: string; size: number; md5: string;   // hex md5 of the bytes
 *     contentType?: string; metadata?: Record<string, string>;
 *   }
 *   // Timestamp-like ({seconds,nanoseconds}, admin-SDK {_seconds,_nanoseconds})
 *   // and Date become { __ts: [s, n] } — the same tagged encoding
 *   // wire-values.ts already speaks. undefined is dropped. Exotic Firestore
 *   // types (GeoPoint, DocumentReference, Bytes) and "__"-tagged keys THROW:
 *   // silently passing them through would land garbage in the store.
 *   export function serializeDocData(data: Record<string, unknown>): Record<string, unknown>;
 *   export function parseManifest(json: unknown): DumpManifest;  // validates or throws
 *
 *   // functions/src/selfhost/migrate-export.ts — handles INJECTED so the
 *   // same code runs against real firebase-admin (scripts side) and against
 *   // the shims (this suite's round-trip). Discovery via listCollections()
 *   // when `collections` is omitted.
 *   export function exportDump(opts: {
 *     dir: string;
 *     firestore?: FirestoreLike;     // .collection(path).get() surface
 *     collections?: string[];        // explicit allow-list (tests, partial exports)
 *     auth?: AuthLike;               // .listUsers() surface
 *     storage?: BucketLike;          // .getFiles({prefix}) / download / getMetadata
 *     storagePrefix?: string;
 *   }): Promise<DumpManifest>;
 *
 *   // functions/src/selfhost/migrate-import.ts — writes ONLY through the
 *   // existing shim write path (rawPut upsert ⇒ idempotence), so canonical
 *   // JSONB + generated columns + tenant_id come out identical to
 *   // organically-written data. Users go through better-auth.provisionUser
 *   // (uid-preserving, passwordless — forced reset), seeding the
 *   // allowedEmails invite gate when missing. Everything lands in the one
 *   // tenant db/tenant.ts names, owner-scoped by the preserved uids.
 *   export interface ImportReport {
 *     dryRun: boolean;
 *     collections: { path: string; docs: number; written: number }[];
 *     users: { provisioned: string[]; existing: string[] };   // uids
 *     storage: { objects: number; written: number; bytes: number };
 *   }
 *   export interface VerifyReport {
 *     ok: boolean;
 *     collections: { path: string; expected: number; missing: string[]; mismatched: string[] }[];
 *     users: { expected: number; missing: string[] };
 *     storage: { expected: number; missing: string[]; checksumFailures: string[] };
 *   }
 *   export function importDump(opts: { dir: string; dryRun?: boolean }): Promise<ImportReport>;
 *   export function verifyDump(opts: { dir: string }): Promise<VerifyReport>;
 *
 * Verification semantics — deliberate: verifyDump proves every dump entry
 * exists in the target and matches (per-doc deep-equal, per-object checksum,
 * per-user presence). It does NOT assert the target contains nothing else —
 * the compose CI Postgres is shared across suites, and "target is empty
 * before import" is a CLI-level precondition of the real cutover runbook,
 * not an importer invariant.
 *
 * Hard constraints proven here:
 *  - ids and Firebase uids preserved verbatim (no row rewriting later)
 *  - Timestamps survive export → NDJSON → import as shim Timestamp instances
 *  - flattened collections land through the SAME write path (pushdown-queryable)
 *  - idempotence: re-running the import converges, never duplicates
 *  - dry-run touches nothing
 *  - the verification gate actually fails on missing/tampered data
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { getAuth as getAdminAuth } from "./auth-shim";
import { createSelfhostAuth } from "./better-auth";

/* The modules under test — variable specifiers so tsc/vite don't resolve
 * the not-yet-existing files; at runtime the imports reject and the xfail
 * marks hold. */
const FORMAT_MODULE = "./dump-format";
const EXPORT_MODULE = "./migrate-export";
const IMPORT_MODULE = "./migrate-import";

interface DumpManifest {
  version: 1;
  exportedAt: string;
  projectId?: string;
  collections: { path: string; file: string; count: number }[];
  users: { file: string; count: number } | null;
  storage: { manifest: string; objectsDir: string; count: number; bytes: number } | null;
}

interface ImportReport {
  dryRun: boolean;
  collections: { path: string; docs: number; written: number }[];
  users: { provisioned: string[]; existing: string[] };
  storage: { objects: number; written: number; bytes: number };
}

interface VerifyReport {
  ok: boolean;
  collections: { path: string; expected: number; missing: string[]; mismatched: string[] }[];
  users: { expected: number; missing: string[] };
  storage: { expected: number; missing: string[]; checksumFailures: string[] };
}

async function loadFormat(): Promise<{
  DUMP_VERSION: number;
  serializeDocData: (data: Record<string, unknown>) => Record<string, unknown>;
  parseManifest: (json: unknown) => DumpManifest;
}> {
  return (await import(/* @vite-ignore */ FORMAT_MODULE)) as never;
}

async function loadExport(): Promise<{
  exportDump: (opts: {
    dir: string;
    firestore?: unknown;
    collections?: string[];
    auth?: unknown;
    storage?: unknown;
    storagePrefix?: string;
  }) => Promise<DumpManifest>;
}> {
  return (await import(/* @vite-ignore */ EXPORT_MODULE)) as never;
}

async function loadImport(): Promise<{
  importDump: (opts: { dir: string; dryRun?: boolean }) => Promise<ImportReport>;
  verifyDump: (opts: { dir: string }) => Promise<VerifyReport>;
}> {
  return (await import(/* @vite-ignore */ IMPORT_MODULE)) as never;
}

/* ------------------------------------------------------------------ */
/* Fixtures — compose CI shares one Postgres across suites AND runs,   */
/* so every id/email/collection is unique per run (see better-auth     */
/* .test.ts:71). Firebase uids are 28 url-safe chars — preserved shape. */
/* ------------------------------------------------------------------ */

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
let seq = 0;
const uniqueUid = () => `W3mig${RUN}${++seq}`.padEnd(28, "x").slice(0, 28);
const uniqueEmail = (tag: string) => `w3-${tag}-${++seq}-${RUN}@example.test`;
/** Bridge-table collection unique to this run (not in FLATTENED). */
const BRIDGE_COLLECTION = `w3migSpec${RUN}`;

async function makeDumpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "w3-dump-"));
}

interface FixtureDoc {
  id: string;
  data: Record<string, unknown>;
}

/** Write a well-formed version-1 dump directory from parts. */
async function writeFixtureDump(opts: {
  collections?: Record<string, FixtureDoc[]>;
  users?: Array<Record<string, unknown>>;
}): Promise<string> {
  const dir = await makeDumpDir();
  const collections: DumpManifest["collections"] = [];
  await fs.mkdir(path.join(dir, "collections"), { recursive: true });
  let fileSeq = 0;
  for (const [colPath, docs] of Object.entries(opts.collections ?? {})) {
    const file = `c${++fileSeq}.ndjson`;
    await fs.writeFile(
      path.join(dir, "collections", file),
      docs.map((d) => JSON.stringify(d)).join("\n") + "\n",
    );
    collections.push({ path: colPath, file, count: docs.length });
  }
  let users: DumpManifest["users"] = null;
  if (opts.users) {
    await fs.writeFile(
      path.join(dir, "users.ndjson"),
      opts.users.map((u) => JSON.stringify(u)).join("\n") + "\n",
    );
    users = { file: "users.ndjson", count: opts.users.length };
  }
  const manifest: DumpManifest = {
    version: 1,
    exportedAt: "2026-07-22T00:00:00.000Z",
    projectId: "fixture-project",
    collections,
    users,
    storage: null,
  };
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

/** A realistic transaction body (flattened collection) — wire-encoded. */
function txFixture(userId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId,
    sourceId: `src-${RUN}`,
    description: "REWE SAGT DANKE 1234",
    amount: -42.9,
    currency: "EUR",
    isComplete: false,
    date: { __ts: [1750000000, 0] },
    createdAt: { __ts: [1750000100, 500000000] },
    ...over,
  };
}

describe("W3 dump format — ⚠ all xfail until W3 lands", () => {
  it("serializeDocData emits wire tags, drops undefined, refuses exotics", async () => {
    const { serializeDocData } = await loadFormat();

    const out = serializeDocData({
      ts: new Timestamp(1750000000, 250),
      when: new Date(1700000000500),
      nested: { arr: [1, "two", new Timestamp(3, 4)] },
      gone: undefined,
      keep: null,
    });
    expect(out.ts).toEqual({ __ts: [1750000000, 250] });
    expect(out.when).toEqual({ __ts: [1700000000, 500000000] });
    expect((out.nested as { arr: unknown[] }).arr[2]).toEqual({ __ts: [3, 4] });
    expect("gone" in out).toBe(false);
    expect(out.keep).toBeNull();

    // Admin-SDK Timestamp shape (underscore fields) must serialize too —
    // the exporter runs against the real SDK, not our shim classes.
    const adminShaped = serializeDocData({ ts: { _seconds: 9, _nanoseconds: 8 } });
    expect(adminShaped.ts).toEqual({ __ts: [9, 8] });

    // Exotic Firestore types: fail loudly, never pass through as garbage.
    const geoPointLike = { latitude: 48.2, longitude: 16.37 };
    Object.defineProperty(geoPointLike, "constructor", { value: { name: "GeoPoint" } });
    expect(() => serializeDocData({ g: geoPointLike })).toThrow();
    expect(() => serializeDocData({ b: Buffer.from("x") })).toThrow();

    // "__"-tagged keys would collide with the wire encoding on re-read.
    expect(() => serializeDocData({ __evil: 1 })).toThrow();
  });

  it("parseManifest validates the dump contract", async () => {
    const { parseManifest, DUMP_VERSION } = await loadFormat();
    expect(DUMP_VERSION).toBe(1);

    const good = {
      version: 1,
      exportedAt: "2026-07-22T00:00:00.000Z",
      collections: [{ path: "transactions", file: "c1.ndjson", count: 2 }],
      users: null,
      storage: null,
    };
    expect(parseManifest(good).collections[0].path).toBe("transactions");

    expect(() => parseManifest({ ...good, version: 2 })).toThrow();
    expect(() => parseManifest({ ...good, collections: undefined })).toThrow();
    expect(() => parseManifest("not an object")).toThrow();
  });
});

describe("W3 importer acceptance — ⚠ all xfail until W3 lands", () => {
  it("module exposes the seam", async () => {
    const imp = await loadImport();
    expect(typeof imp.importDump).toBe("function");
    expect(typeof imp.verifyDump).toBe("function");
    const exp = await loadExport();
    expect(typeof exp.exportDump).toBe("function");
  });

  it("dry-run reports the full plan and writes nothing", async () => {
    const { importDump } = await loadImport();
    const uid = uniqueUid();
    const email = uniqueEmail("dry");
    const docId = `dry-${RUN}`;
    const dir = await writeFixtureDump({
      collections: {
        transactions: [{ id: docId, data: txFixture(uid) }],
        [BRIDGE_COLLECTION]: [{ id: docId, data: { note: "bridge", userId: uid } }],
      },
      users: [{ uid, email, providerIds: ["password"] }],
    });

    const report = await importDump({ dir, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.collections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "transactions", docs: 1 }),
        expect.objectContaining({ path: BRIDGE_COLLECTION, docs: 1 }),
      ]),
    );

    // Nothing may have been written: docs absent, user absent.
    expect((await getFirestore().collection("transactions").doc(docId).get()).exists).toBe(false);
    expect((await getFirestore().collection(BRIDGE_COLLECTION).doc(docId).get()).exists).toBe(false);
    await expect(getAdminAuth().getUser(uid)).rejects.toThrow();
  });

  it("imports bridge-collection docs: ids preserved, Timestamps revived", async () => {
    const { importDump } = await loadImport();
    const docId = `bridge-${RUN}`;
    const dir = await writeFixtureDump({
      collections: {
        [BRIDGE_COLLECTION]: [
          {
            id: docId,
            data: {
              email: "a@example.test",
              paidAt: { __ts: [1750001234, 40] },
              tags: ["x", "y"],
              nested: { n: 1 },
            },
          },
        ],
      },
    });
    await importDump({ dir });

    const snap = await getFirestore().collection(BRIDGE_COLLECTION).doc(docId).get();
    expect(snap.exists).toBe(true);
    const data = snap.data() as Record<string, unknown>;
    expect(data.email).toBe("a@example.test");
    expect(data.tags).toEqual(["x", "y"]);
    expect(data.nested).toEqual({ n: 1 });
    expect(data.paidAt).toBeInstanceOf(Timestamp);
    expect((data.paidAt as Timestamp).seconds).toBe(1750001234);
    expect((data.paidAt as Timestamp).nanoseconds).toBe(40);
  });

  it("imports flattened collections through the shared write path (pushdown-queryable)", async () => {
    const { importDump } = await loadImport();
    const uid = uniqueUid();
    const dir = await writeFixtureDump({
      collections: {
        transactions: [
          { id: `tx1-${RUN}`, data: txFixture(uid, { amount: -42.9 }) },
          { id: `tx2-${RUN}`, data: txFixture(uid, { amount: 1500, date: { __ts: [1750100000, 0] } }) },
        ],
      },
    });
    await importDump({ dir });

    // where() on a generated column + orderBy on the timestamp column —
    // this only works if the importer used the same write path as the app.
    const snap = await getFirestore()
      .collection("transactions")
      .where("userId", "==", uid)
      .orderBy("date", "desc")
      .get();
    expect(snap.docs.map((d) => d.id)).toEqual([`tx2-${RUN}`, `tx1-${RUN}`]);
    expect(snap.docs[1].get("amount")).toBe(-42.9);
    expect(snap.docs[0].get("date")).toBeInstanceOf(Timestamp);
  });

  it("provisions users uid-preserving, passwordless, with admin claims and invite gate", async () => {
    const { importDump } = await loadImport();
    const adminUid = uniqueUid();
    const plainUid = uniqueUid();
    const adminEmail = uniqueEmail("admin");
    const plainEmail = uniqueEmail("plain");
    const dir = await writeFixtureDump({
      users: [
        { uid: adminUid, email: adminEmail, displayName: "Stefan Fixture", admin: true, providerIds: ["password"] },
        { uid: plainUid, email: plainEmail, providerIds: ["google.com"] },
      ],
    });
    const report = await importDump({ dir });
    expect(report.users.provisioned).toEqual(expect.arrayContaining([adminUid, plainUid]));

    // uid preserved, profile fields carried, admin claim ported.
    const adminUser = await getAdminAuth().getUser(adminUid);
    expect(adminUser.email).toBe(adminEmail);
    expect(adminUser.displayName).toBe("Stefan Fixture");
    expect((adminUser.customClaims as Record<string, unknown> | undefined)?.admin).toBe(true);
    const plainUser = await getAdminAuth().getUser(plainUid);
    expect((plainUser.customClaims as Record<string, unknown> | undefined)?.admin).toBeUndefined();

    // Passwordless (forced reset): no credential can sign in.
    const auth = await createSelfhostAuth();
    await expect(auth.signInEmail(adminEmail, "anything at all")).rejects.toThrow();

    // Invite gate seeded so the migrated user's social sign-in isn't
    // rejected by the user.create hook on the new stack.
    const gate = await getFirestore().collection("allowedEmails").where("email", "==", plainEmail).get();
    expect(gate.docs.length).toBeGreaterThan(0);
  });

  it("re-running the import converges (idempotent, resumable-by-rerun)", async () => {
    const { importDump, verifyDump } = await loadImport();
    const uid = uniqueUid();
    const email = uniqueEmail("idem");
    const dir = await writeFixtureDump({
      collections: {
        transactions: [
          { id: `idem1-${RUN}`, data: txFixture(uid) },
          { id: `idem2-${RUN}`, data: txFixture(uid, { amount: 7 }) },
        ],
      },
      users: [{ uid, email, providerIds: ["password"] }],
    });

    await importDump({ dir });
    const second = await importDump({ dir });

    // Second run reports the user as pre-existing, not an error.
    expect(second.users.existing).toContain(uid);
    expect(second.users.provisioned).not.toContain(uid);

    // No duplicated rows: exactly the dump's docs for this uid.
    const snap = await getFirestore().collection("transactions").where("userId", "==", uid).get();
    expect(snap.docs.length).toBe(2);

    const verdict = await verifyDump({ dir });
    expect(verdict.ok).toBe(true);
  });

  it("verifyDump fails the gate on missing and tampered docs", async () => {
    const { importDump, verifyDump } = await loadImport();
    const uid = uniqueUid();
    const missingId = `gone-${RUN}`;
    const tamperedId = `tampered-${RUN}`;
    const dir = await writeFixtureDump({
      collections: {
        [BRIDGE_COLLECTION]: [
          { id: missingId, data: { userId: uid, v: 1 } },
          { id: tamperedId, data: { userId: uid, v: 2 } },
        ],
      },
    });
    await importDump({ dir });
    expect((await verifyDump({ dir })).ok).toBe(true);

    await getFirestore().collection(BRIDGE_COLLECTION).doc(missingId).delete();
    await getFirestore().collection(BRIDGE_COLLECTION).doc(tamperedId).update({ v: 999 });

    const verdict = await verifyDump({ dir });
    expect(verdict.ok).toBe(false);
    const col = verdict.collections.find((c) => c.path === BRIDGE_COLLECTION);
    expect(col?.missing).toContain(missingId);
    expect(col?.mismatched).toContain(tamperedId);
  });

  it("round-trip: shim-seeded data exports, wipes, re-imports identically", async () => {
    const { exportDump } = await loadExport();
    const { importDump, verifyDump } = await loadImport();
    const uid = uniqueUid();
    // Isolated collection: the export below asserts a collection-wide count,
    // which the shared BRIDGE_COLLECTION can't guarantee — the bridge-import
    // and verify tests above legitimately leave their own docs in it.
    const rtCol = `w3migRt${RUN}`;

    // Seed through the ordinary app write path, Timestamps included.
    const seeded = {
      userId: uid,
      name: "Röntgen & Söhne GmbH",
      openedAt: new Timestamp(1750009999, 123456789),
      lines: [{ qty: 2, unit: "h" }],
    };
    await getFirestore().collection(rtCol).doc(`rt-${RUN}`).set(seeded);
    await getFirestore()
      .collection("transactions")
      .doc(`rt-tx-${RUN}`)
      .set({ ...txFixture(uid), date: new Timestamp(1750000000, 0), createdAt: new Timestamp(1750000100, 500000000) });

    const dir = await makeDumpDir();
    const manifest = await exportDump({
      dir,
      firestore: getFirestore(),
      collections: [rtCol, "transactions"],
    });
    expect(manifest.version).toBe(1);
    expect(manifest.collections.find((c) => c.path === rtCol)?.count).toBe(1);

    // Wipe the tenant, then restore purely from the dump.
    await __resetFirestoreShim();
    await importDump({ dir });
    expect((await verifyDump({ dir })).ok).toBe(true);

    const restored = (await getFirestore().collection(rtCol).doc(`rt-${RUN}`).get()).data() as Record<
      string,
      unknown
    >;
    expect(restored.name).toBe("Röntgen & Söhne GmbH");
    expect(restored.lines).toEqual([{ qty: 2, unit: "h" }]);
    expect(restored.openedAt).toBeInstanceOf(Timestamp);
    expect((restored.openedAt as Timestamp).nanoseconds).toBe(123456789);

    const tx = await getFirestore().collection("transactions").where("userId", "==", uid).get();
    expect(tx.docs.length).toBe(1);
    expect(tx.docs[0].get("amount")).toBe(-42.9);
  });
});
