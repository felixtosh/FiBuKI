/**
 * The duplicate guard lives at the write, not in each ingestion path.
 *
 * Six paths ingest documents; five carried their own copy of a check-then-write
 * and MCP `upload_file` carried none at all, so it wrote Files with no hash —
 * records nothing could ever recognise as copies (#182). The check moved into
 * `createFileRecord`, which every path now writes through.
 *
 * The load-bearing test is the first one: it asserts the refusal AT THE WRITE
 * POINT, so a seventh path inherits it by writing at all. The per-path tests
 * below it then pin each existing path against the same claim. Where a path's
 * own function can be driven here it is driven (the callable the two UI drops
 * enter through, inbound mail's `createFileDocument`, the MCP tool end to end);
 * where the write sits at the end of a Gmail download the test carries that
 * path's record shape into the write point instead, and `no path writes to
 * files except through the write point` is what keeps those two honest.
 *
 * That walk covers `app`, `lib`, `components` and `hooks` as well now — the
 * write this ticket removed was a client-SDK `addDoc` in `lib/operations`, and
 * a walk of `functions/src` alone would not see it come back. The Chrome
 * extension's upload route is the seventh path and writes through the same
 * point; driving it needs the root dependency tree, so its test is
 * src/api-smoke/browser-upload-duplicate.test.ts.
 *
 * Byte-level only: same bytes, same hash. Two different scans of one invoice
 * are two documents here — that is #162.
 *
 *   npx vitest run src/files/__tests__/duplicate-guard.test.ts --pool=forks --maxWorkers=1
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { store, createMockFirestore } from "../../test/setup";

vi.mock("firebase-admin/firestore", () => {
  class MockTimestamp {
    constructor(private readonly date: Date) {}
    static fromDate(d: Date) {
      return new MockTimestamp(d);
    }
    static now() {
      return new MockTimestamp(new Date("2026-09-11T09:00:00Z"));
    }
    toDate() {
      return this.date;
    }
    valueOf() {
      return this.date.getTime();
    }
  }

  return {
    getFirestore: () => createMockFirestore(),
    FieldValue: {
      serverTimestamp: () => new Date("2026-09-11T09:00:00Z"),
      arrayUnion: (...elements: unknown[]) => ({ elements, constructor: { name: "ArrayUnionTransform" } }),
      arrayRemove: (...elements: unknown[]) => ({ elements, constructor: { name: "ArrayRemoveTransform" } }),
      increment: (n: number) => n,
      delete: () => ({ constructor: { name: "DeleteTransform" } }),
    },
    Timestamp: MockTimestamp,
  };
});

// Storage is a sink here: the tool saves bytes, the assertions are about the
// record it writes next to them.
const saved = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("firebase-admin/storage", () => ({
  getStorage: () => ({
    bucket: () => ({
      name: "test-bucket",
      file: (path: string) => ({
        save: async () => {
          saved.paths.push(path);
        },
        getMetadata: async () => [{ metadata: {} }],
        setMetadata: async () => undefined,
      }),
    }),
  }),
}));

vi.mock("firebase-functions/params", () => ({
  defineSecret: (name: string) => ({ value: () => `test-${name}` }),
}));

// Puppeteer, via the inbound-mail body-to-PDF converter. Never launched here.
vi.mock("../../precision-search/htmlToPdf", () => ({
  convertHtmlToPdf: vi.fn(),
}));

const { Timestamp } = await import("firebase-admin/firestore");
const { createFileRecord, MissingContentHashError } = await import("../createFileRecord");
const { createFileCallable } = await import("../createFile");
const { createFileDocument } = await import("../../email-inbound/receiveEmail");
const handlers = await import("../../tools/handlers");

const USER = "user-1";
const HASH = "a".repeat(64);

const db = () => createMockFirestore() as unknown as FirebaseFirestore.Firestore;

/** Every File the store holds for our user. */
const filesOnRecord = () => store.queryDocs("files", [{ field: "userId", op: "==", value: USER }]);

/** The callable, invoked the way firebase-functions' own unit tests do. */
function callCreateFile(data: Record<string, unknown>) {
  return (createFileCallable as unknown as {
    run: (r: never) => Promise<{ success: boolean; fileId: string; duplicate: boolean }>;
  }).run({ data: { data }, auth: { uid: USER } } as never);
}

/** What a UI drop sends once the bytes are in storage. */
const uiUpload = (overrides: Record<string, unknown> = {}) => ({
  fileName: "rechnung.pdf",
  fileType: "application/pdf",
  fileSize: 148_221,
  storagePath: `files/${USER}/1757577600000_rechnung.pdf`,
  downloadUrl: "https://example.test/rechnung.pdf",
  contentHash: HASH,
  ...overrides,
});

beforeEach(() => {
  store.clear();
  saved.paths.length = 0;
});

// ---------------------------------------------------------------------------
// The write point
// ---------------------------------------------------------------------------

describe("createFileRecord — the write point", () => {
  it("creates nothing on a second write of identical bytes and returns the first File id", async () => {
    const first = await createFileRecord(db(), {
      userId: USER,
      fileName: "rechnung.pdf",
      contentHash: HASH,
    });
    const second = await createFileRecord(db(), {
      userId: USER,
      fileName: "rechnung-kopie.pdf",
      contentHash: HASH,
    });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.fileId).toBe(first.fileId);
    expect(filesOnRecord()).toHaveLength(1);
    // The first File is untouched — a duplicate write is not an update.
    expect(store.getDoc("files", first.fileId)?.fileName).toBe("rechnung.pdf");
  });

  it("refuses a write that carries no content hash", async () => {
    await expect(
      createFileRecord(db(), { userId: USER, fileName: "rechnung.pdf" })
    ).rejects.toBeInstanceOf(MissingContentHashError);

    expect(filesOnRecord()).toHaveLength(0);
  });

  it("keeps another user's identical bytes apart", async () => {
    const mine = await createFileRecord(db(), { userId: USER, contentHash: HASH });
    const theirs = await createFileRecord(db(), { userId: "user-2", contentHash: HASH });

    expect(theirs.duplicate).toBe(false);
    expect(theirs.fileId).not.toBe(mine.fileId);
  });

  it("treats a soft-deleted File as already on record", async () => {
    // Re-creating it would leave the user with the copy they deleted plus a
    // new one. Restoring is what brings a deleted File back (ADR-0006).
    store.setDoc("files", "deleted-1", {
      userId: USER,
      contentHash: HASH,
      fileName: "rechnung.pdf",
      deletedAt: new Date("2026-09-01T00:00:00Z"),
    });

    const result = await createFileRecord(db(), { userId: USER, contentHash: HASH });

    expect(result).toEqual({ fileId: "deleted-1", duplicate: true });
    expect(filesOnRecord()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// One per ingestion path
// ---------------------------------------------------------------------------

describe("every ingestion path writes through it", () => {
  it("UI upload — Files page: a second drop of the same bytes creates nothing", async () => {
    const first = await callCreateFile(uiUpload());
    const second = await callCreateFile(uiUpload({ fileName: "rechnung (1).pdf" }));

    expect(second.fileId).toBe(first.fileId);
    expect(second.duplicate).toBe(true);
    expect(filesOnRecord()).toHaveLength(1);
  });

  it("Drop on a Transaction: the same bytes dropped again create nothing", async () => {
    // Same entry point as the Files page — both UI drops call `createFile`
    // in lib/operations, which is the callable.
    const first = await callCreateFile(uiUpload({ fileName: "beleg.pdf" }));
    const second = await callCreateFile(uiUpload({ fileName: "beleg.pdf" }));

    expect(second.fileId).toBe(first.fileId);
    expect(second.duplicate).toBe(true);
    expect(filesOnRecord()).toHaveLength(1);
  });

  it("the callable refuses a File with no hash rather than storing one", async () => {
    const { contentHash: _dropped, ...noHash } = uiUpload();

    await expect(callCreateFile(noHash)).rejects.toMatchObject({
      code: "invalid-argument",
    });
    expect(filesOnRecord()).toHaveLength(0);
  });

  it("Gmail Sync: the same attachment synced twice creates one File", async () => {
    const attachment = (messageId: string) => ({
      userId: USER,
      fileName: "invoice.pdf",
      fileType: "application/pdf",
      fileSize: 232_118,
      storagePath: `files/${USER}/1757577600000_invoice.pdf`,
      downloadUrl: "https://example.test/invoice.pdf",
      contentHash: HASH,
      sourceType: "gmail",
      gmailMessageId: messageId,
      gmailAttachmentId: "att-1",
      extractionComplete: false,
      transactionIds: [],
    });

    const first = await createFileRecord(db(), attachment("msg-1"));
    // Same document, forwarded: a different message carrying the same bytes.
    const second = await createFileRecord(db(), attachment("msg-2"));

    expect(second.fileId).toBe(first.fileId);
    expect(second.duplicate).toBe(true);
    expect(filesOnRecord()).toHaveLength(1);
  });

  it("Inbound mail: the same mail delivered twice creates one File", async () => {
    const inbound = () => ({
      userId: USER,
      fileName: "beleg.pdf",
      fileType: "application/pdf",
      fileSize: 90_112,
      storagePath: `files/${USER}/1757577600000_beleg.pdf`,
      downloadUrl: "https://example.test/beleg.pdf",
      contentHash: HASH,
      sourceType: "email_inbound" as const,
      inboundEmailId: "inbound-1",
      inboundEmailAddress: "stefan@fibuki.com",
      inboundMessageId: "mail-1",
      inboundFrom: "rechnung@lieferant.at",
      inboundSubject: "Ihre Rechnung",
      inboundReceivedAt: Timestamp.fromDate(new Date("2026-09-10T08:00:00Z")),
    });

    const first = await createFileDocument(inbound());
    const second = await createFileDocument(inbound());

    expect(second).toBe(first);
    expect(filesOnRecord()).toHaveLength(1);
  });

  it("Precision Search: a second hit on the same document creates one File", async () => {
    const found = (hint: string) => ({
      userId: USER,
      fileName: "rechnung.pdf",
      fileType: "application/pdf",
      fileSize: 145_004,
      storagePath: `files/${USER}/1757577600000_rechnung.pdf`,
      downloadUrl: "https://example.test/rechnung.pdf",
      contentHash: HASH,
      sourceType: "gmail",
      extractionComplete: false,
      transactionIds: [],
      precisionSearchHint: { transactionId: hint },
    });

    const first = await createFileRecord(db(), found("tx-1"));
    const second = await createFileRecord(db(), found("tx-2"));

    expect(second.fileId).toBe(first.fileId);
    expect(second.duplicate).toBe(true);
    expect(filesOnRecord()).toHaveLength(1);
  });

  it("MCP upload_file: a repeated upload of identical bytes returns the existing File", async () => {
    const base64 = Buffer.from("%PDF-1.4 one invoice").toString("base64");
    const args = { base64, fileName: "rechnung.pdf", mimeType: "application/pdf" };

    const first = await handlers.uploadFile(USER, args);
    const second = await handlers.uploadFile(USER, { ...args, fileName: "same-bytes.pdf" });

    expect(second.fileId).toBe(first.fileId);
    expect(second.duplicate).toBe(true);
    expect(filesOnRecord()).toHaveLength(1);
    // And it did not re-upload bytes it already had.
    expect(saved.paths).toHaveLength(1);
  });

  it("MCP upload_file: the File it writes carries a content hash", async () => {
    const bytes = Buffer.from("%PDF-1.4 one invoice");
    const result = await handlers.uploadFile(USER, {
      base64: bytes.toString("base64"),
      fileName: "rechnung.pdf",
      mimeType: "application/pdf",
    });

    const written = store.getDoc("files", result.fileId)!;
    expect(written.contentHash).toBe(
      createHash("sha256").update(bytes).digest("hex")
    );
  });
});

// ---------------------------------------------------------------------------
// The structural half of "asserted at createFile, not per ingestion path"
// ---------------------------------------------------------------------------

describe("no path writes to files except through the write point", () => {
  // Both shapes that put a new document in `files` through the Admin SDK:
  // `.add(record)` and `.doc(...).set(record)`. Matching only the first would
  // let a seventh path reintroduce the bug by writing the other way round,
  // which is the one thing this test exists to stop.
  const CREATES_A_FILE_ADMIN =
    /collection\(\s*(?:"files"|'files'|FILES_COLLECTION)\s*\)(?:\s*\.doc\([^)]*\))?\s*\.(?:add|set)\(/;

  // And the client SDK's free-function form, `addDoc(collection(db, ...))` /
  // `setDoc(doc(db, ...))`. That is the shape the write this ticket removed was
  // written in — `lib/operations/file-ops.ts` held it — so leaving it out would
  // let the bug come back in the exact spelling it arrived in.
  const CREATES_A_FILE_CLIENT =
    /(?:addDoc|setDoc)\(\s*(?:collection|doc)\(\s*[^)]*(?:"files"|'files'|FILES_COLLECTION)/;

  const createsAFile = (source: string) =>
    CREATES_A_FILE_ADMIN.test(source) || CREATES_A_FILE_CLIENT.test(source);

  // The two Gmail routes dedupe on a field called `fileHash`, not
  // `contentHash`, so their records are invisible to the write point's lookup
  // and routing them means first deciding what happens to that field — a
  // rename with a data question attached. That is #328. Until it lands they
  // are named here one by one, so the hole is exactly two files wide and a
  // third writer cannot hide in it.
  const ROUTED_BY_328 = [
    join("app", "api", "gmail", "attachment", "route.ts"),
    join("app", "api", "gmail", "convert-to-pdf", "route.ts"),
  ];

  const repoRoot = join(__dirname, "..", "..", "..", "..");

  it("has exactly one `files` write across functions/src, app and the client trees", () => {
    const offenders: string[] = [];

    const walk = (dir: string) => {
      // withFileTypes, so the entry's kind comes from the one directory read
      // rather than a second stat() of a path that could have changed between
      // the two calls (CodeQL js/file-system-race).
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "__tests__") continue;
          walk(path);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
        if (path.endsWith(join("files", "createFileRecord.ts"))) continue;

        const relative = path.slice(repoRoot.length + 1);
        if (ROUTED_BY_328.includes(relative)) continue;

        const source = readFileSync(path, "utf8");
        if (createsAFile(source)) {
          offenders.push(relative);
        }
      }
    };

    // Walking `functions/src` alone left app/api free to write its own way —
    // which is where the Chrome extension's upload did, hash in hand, no guard.
    // The client trees are walked for the same reason: `lib/operations` wrote
    // `files` from the browser until this ticket, and nothing outside this walk
    // would notice it going back.
    walk(join(repoRoot, "functions", "src"));
    walk(join(repoRoot, "app"));
    walk(join(repoRoot, "lib"));
    walk(join(repoRoot, "components"));
    walk(join(repoRoot, "hooks"));

    // A seventh path that writes its own way is a seventh path with no guard.
    expect(offenders).toEqual([]);
  });

  it("still sees the two writes #328 leaves out", () => {
    // The allow-list is only honest if the files on it would otherwise fail.
    // When one of them stops writing `files` itself, this fails and the entry
    // comes off the list rather than quietly covering a path that moved.
    for (const relative of ROUTED_BY_328) {
      expect(createsAFile(readFileSync(join(repoRoot, relative), "utf8"))).toBe(true);
    }
  });

  it("catches the write shapes it is meant to catch", () => {
    // Without this the walk above is unfalsifiable: a pattern that matches
    // nothing passes just as quietly as a codebase with one write point.
    expect(createsAFile('db.collection("files").add(record)')).toBe(true);
    expect(createsAFile('db.collection(FILES_COLLECTION).add(record)')).toBe(true);
    expect(createsAFile("db.collection('files').add(record)")).toBe(true);
    expect(createsAFile('db.collection("files").doc().set(record)')).toBe(true);
    expect(createsAFile('db.collection("files").doc(id).set(record)')).toBe(true);
    // The client SDK, including the line-broken spelling prettier produces.
    expect(createsAFile('addDoc(collection(ctx.db, FILES_COLLECTION), newFile)')).toBe(true);
    expect(createsAFile('await addDoc(\n  collection(db, "files"),\n  newFile\n)')).toBe(true);
    expect(createsAFile('setDoc(doc(ctx.db, FILES_COLLECTION, id), newFile)')).toBe(true);
    // Reads and updates are not writes of a new File.
    expect(createsAFile('db.collection("files").doc(id).get()')).toBe(false);
    expect(createsAFile('db.collection("files").where("userId", "==", u)')).toBe(false);
    expect(createsAFile('updateDoc(doc(ctx.db, FILES_COLLECTION, fileId), patch)')).toBe(false);
    expect(createsAFile('getDoc(doc(ctx.db, FILES_COLLECTION, fileId))')).toBe(false);
  });
});
