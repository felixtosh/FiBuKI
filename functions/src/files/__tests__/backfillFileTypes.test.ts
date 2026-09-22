/**
 * #248: 18 of 539 production file records were written with no `fileType`
 * at all — every one of them a PDF. Extraction was fixed to sniff the bytes
 * (see geminiParser's sniffMimeType); this backfill runs that same sniffer
 * once over every file record still missing the field, so every other
 * consumer (download headers, matching, the agent tools) stops lying too.
 *
 * #281: only a magic-number match is persisted. Bytes the sniffer cannot name
 * keep no `fileType` and are counted separately, because the sniffer's
 * image/jpeg fallback is a guess and a persisted guess cannot be found again.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, createMockFirestore, createTestFile } from "../../test/setup";

vi.mock("firebase-admin/firestore", () => {
  return {
    getFirestore: () => createMockFirestore(),
    FieldValue: {
      serverTimestamp: () => new Date("2026-09-10T12:00:00Z"),
    },
  };
});

const blobs = new Map<string, Buffer>();

vi.mock("firebase-admin/storage", () => ({
  getStorage: () => ({
    bucket: () => ({
      file: (path: string) => ({
        download: async () => {
          const buf = blobs.get(path);
          if (!buf) {
            throw Object.assign(new Error(`No such object: ${path}`), { code: 404 });
          }
          return [buf];
        },
      }),
    }),
  }),
}));

const { backfillFileTypesCallable } = await import("../backfillFileTypes");

const userId = "user-1";

function call() {
  return (backfillFileTypesCallable as unknown as {
    run: (r: never) => Promise<{
      success: boolean;
      updated: number;
      skipped: number;
      unidentified: number;
    }>;
  }).run({ data: {}, auth: { uid: userId } } as never);
}

const file = (id: string) => store.getDoc("files", id) as Record<string, unknown>;

const PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(20)]);
const PNG_BYTES = Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG"), Buffer.alloc(20)]);
// An OOXML container (.docx/.xlsx): a real file, readable, and not one of the
// magic numbers the sniffer knows. sniffMimeType would call it image/jpeg.
const DOCX_BYTES = Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(20)]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);

beforeEach(() => {
  store.clear();
  blobs.clear();
});

describe("backfillFileTypesCallable", () => {
  it("sniffs a PDF record missing fileType from its bytes", async () => {
    store.setDoc(
      "files",
      "f-pdf",
      createTestFile({ userId, storagePath: "files/user-1/a.pdf", fileType: undefined })
    );
    blobs.set("files/user-1/a.pdf", PDF_BYTES);

    const result = await call();

    expect(result.success).toBe(true);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.unidentified).toBe(0);
    expect(file("f-pdf").fileType).toBe("application/pdf");
  });

  it("sniffs an image record missing fileType from its bytes", async () => {
    store.setDoc(
      "files",
      "f-img",
      createTestFile({ userId, storagePath: "files/user-1/b.png", fileType: undefined })
    );
    blobs.set("files/user-1/b.png", PNG_BYTES);

    const result = await call();

    expect(result.updated).toBe(1);
    expect(result.unidentified).toBe(0);
    expect(file("f-img").fileType).toBe("image/png");
  });

  // image/jpeg is the value the sniffer's fallback used to persist, so it is the
  // one recognised type a "don't write the guess" change can wrongly swallow.
  // A real JPEG still has to be written (#281).
  it("still writes image/jpeg when the bytes really are a JPEG", async () => {
    store.setDoc(
      "files",
      "f-jpg",
      createTestFile({ userId, storagePath: "files/user-1/d.jpg", fileType: undefined })
    );
    blobs.set("files/user-1/d.jpg", JPEG_BYTES);

    const result = await call();

    expect(result.updated).toBe(1);
    expect(result.unidentified).toBe(0);
    expect(file("f-jpg").fileType).toBe("image/jpeg");
  });

  it("leaves a record whose bytes match no magic number with no fileType (#281)", async () => {
    store.setDoc(
      "files",
      "f-docx",
      createTestFile({ userId, storagePath: "files/user-1/c.docx", fileType: undefined })
    );
    blobs.set("files/user-1/c.docx", DOCX_BYTES);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await call();
    const lines = warn.mock.calls.map((args) => String(args[0]));
    warn.mockRestore();

    expect(result.updated).toBe(0);
    expect(result.unidentified).toBe(1);
    // Not folded into `skipped`: the blob downloaded fine, it is just unnameable.
    expect(result.skipped).toBe(0);
    expect(file("f-docx").fileType).toBeUndefined();
    expect(lines.some((line) => line.includes("f-docx") && line.includes("magic number"))).toBe(
      true
    );
  });

  it("an unidentifiable record does not stop the identifiable ones (#281)", async () => {
    store.setDoc(
      "files",
      "f-docx",
      createTestFile({ userId, storagePath: "files/user-1/c.docx", fileType: undefined })
    );
    store.setDoc(
      "files",
      "f-pdf",
      createTestFile({ userId, storagePath: "files/user-1/a.pdf", fileType: undefined })
    );
    blobs.set("files/user-1/c.docx", DOCX_BYTES);
    blobs.set("files/user-1/a.pdf", PDF_BYTES);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await call();
    warn.mockRestore();

    expect(result.updated).toBe(1);
    expect(result.unidentified).toBe(1);
    expect(file("f-pdf").fileType).toBe("application/pdf");
    expect(file("f-docx").fileType).toBeUndefined();
  });

  it("is idempotent: a record that already has a fileType is left alone", async () => {
    store.setDoc("files", "f-ok", createTestFile({ userId, fileType: "application/pdf" }));

    const result = await call();

    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(file("f-ok").fileType).toBe("application/pdf");
  });

  it("only touches the calling user's own files", async () => {
    store.setDoc(
      "files",
      "f-other",
      createTestFile({ userId: "someone-else", storagePath: "files/other/a.pdf", fileType: undefined })
    );
    blobs.set("files/other/a.pdf", PDF_BYTES);

    const result = await call();

    expect(result.updated).toBe(0);
    expect(file("f-other").fileType).toBeUndefined();
  });

  it("a record whose storage object is gone is skipped, not fatal to the rest", async () => {
    store.setDoc(
      "files",
      "f-gone",
      createTestFile({ userId, storagePath: "files/user-1/gone.pdf", fileType: undefined })
    );
    store.setDoc(
      "files",
      "f-ok",
      createTestFile({ userId, storagePath: "files/user-1/a.pdf", fileType: undefined })
    );
    blobs.set("files/user-1/a.pdf", PDF_BYTES);

    const result = await call();

    expect(result.success).toBe(true);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.unidentified).toBe(0);
    expect(file("f-ok").fileType).toBe("application/pdf");
    expect(file("f-gone").fileType).toBeUndefined();
  });

  it("a record with no storagePath is skipped", async () => {
    store.setDoc(
      "files",
      "f-nopath",
      createTestFile({ userId, storagePath: undefined, fileType: undefined })
    );

    const result = await call();

    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.unidentified).toBe(0);
  });

  it("after the backfill, no file with recognisable bytes is missing a fileType", async () => {
    store.setDoc(
      "files",
      "f1",
      createTestFile({ userId, storagePath: "files/user-1/a.pdf", fileType: undefined })
    );
    store.setDoc(
      "files",
      "f2",
      createTestFile({ userId, storagePath: "files/user-1/b.png", fileType: undefined })
    );
    blobs.set("files/user-1/a.pdf", PDF_BYTES);
    blobs.set("files/user-1/b.png", PNG_BYTES);

    await call();

    const remaining = store
      .queryDocs("files", [{ field: "userId", op: "==", value: userId }])
      .filter((d) => !d.data.fileType);
    expect(remaining.length).toBe(0);
  });
});
