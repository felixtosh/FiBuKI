/**
 * W3 (storage migration) — object-copy acceptance suite. GREEN as of chunk 3:
 * `./migrate-import` extends importDump/verifyDump over a non-null
 * manifest.storage — see migrate-import.test.ts for the full seam and
 * handoffs/2026-07-22-w3-migration-impl.md for the implementation brief.
 *
 * Storage side of the dump contract (version 1):
 *
 *   storage-manifest.ndjson   one StorageLine per line:
 *     { path, size, md5, contentType?, metadata? }   // md5 = hex of bytes
 *   objects/<path...>         raw bytes, Firebase Storage paths VERBATIM
 *
 * Constraints proven here (phase-2 W3: "object copy keyed by the same paths
 * blobstore-s3.ts already serves; verify by count + spot checksums"):
 *  - object keys are the Firebase paths verbatim — no rekeying, so every
 *    stored path reference in migrated Firestore docs keeps resolving
 *  - custom metadata survives (download-token keys, umlaut filenames)
 *  - checksum verification actually fails on corrupted/missing objects
 *  - idempotent re-run, dry-run writes nothing
 *
 * Runs against whatever blob store the profile configures: memory locally
 * (set below when nothing is configured), real MinIO in compose CI
 * (FIBUKI_STORAGE=s3). Shared-store rule: all object paths are unique per
 * run — an S3 bucket, unlike the memory store, persists across suites.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { getStorage, _resetStorageForTests } from "./storage-shim";

const IMPORT_MODULE = "./migrate-import";
const EXPORT_MODULE = "./migrate-export";

interface VerifyReport {
  ok: boolean;
  storage: { expected: number; missing: string[]; checksumFailures: string[] };
}

interface ImportReport {
  dryRun: boolean;
  storage: { objects: number; written: number; bytes: number };
}

async function loadImport(): Promise<{
  importDump: (opts: { dir: string; dryRun?: boolean }) => Promise<ImportReport>;
  verifyDump: (opts: { dir: string }) => Promise<VerifyReport>;
}> {
  return (await import(/* @vite-ignore */ IMPORT_MODULE)) as never;
}

async function loadExport(): Promise<{
  exportDump: (opts: {
    dir: string;
    storage?: unknown;
    storagePrefix?: string;
  }) => Promise<{ storage: { count: number; bytes: number } | null }>;
}> {
  return (await import(/* @vite-ignore */ EXPORT_MODULE)) as never;
}

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const PREFIX = `files/w3mig${RUN}`;

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

const md5hex = (b: Buffer) => createHash("md5").update(b).digest("hex");

interface FixtureObject {
  path: string;
  bytes: Buffer;
  contentType?: string;
  metadata?: Record<string, string>;
}

/** Write a storage-only version-1 dump directory. */
async function writeStorageDump(objects: FixtureObject[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "w3-storage-dump-"));
  await fs.mkdir(path.join(dir, "collections"), { recursive: true });
  let bytes = 0;
  const lines: string[] = [];
  for (const o of objects) {
    const target = path.join(dir, "objects", o.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, o.bytes);
    bytes += o.bytes.length;
    lines.push(
      JSON.stringify({
        path: o.path,
        size: o.bytes.length,
        md5: md5hex(o.bytes),
        contentType: o.contentType,
        metadata: o.metadata,
      }),
    );
  }
  await fs.writeFile(path.join(dir, "storage-manifest.ndjson"), lines.join("\n") + "\n");
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        exportedAt: "2026-07-22T00:00:00.000Z",
        collections: [],
        users: null,
        storage: {
          manifest: "storage-manifest.ndjson",
          objectsDir: "objects",
          count: objects.length,
          bytes,
        },
      },
      null,
      2,
    ),
  );
  return dir;
}

describe("W3 storage migration acceptance", () => {
  it("copies objects to verbatim paths with bytes and metadata intact", async () => {
    const { importDump, verifyDump } = await loadImport();
    const pdf = Buffer.from(`%PDF-1.4 fixture ${RUN}`);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3]);
    const dir = await writeStorageDump([
      {
        path: `${PREFIX}/u1/Beleg Übernachtung.pdf`,
        bytes: pdf,
        contentType: "application/pdf",
        metadata: { firebaseStorageDownloadTokens: "tok-123", originalName: "Beleg Übernachtung.pdf" },
      },
      { path: `${PREFIX}/u1/scan.png`, bytes: png, contentType: "image/png" },
    ]);

    const report = await importDump({ dir });
    expect(report.storage.objects).toBe(2);
    expect(report.storage.bytes).toBe(pdf.length + png.length);

    const bucket = getStorage().bucket();
    const [downloaded] = await bucket.file(`${PREFIX}/u1/Beleg Übernachtung.pdf`).download();
    expect(downloaded.equals(pdf)).toBe(true);
    const [meta] = await bucket.file(`${PREFIX}/u1/Beleg Übernachtung.pdf`).getMetadata();
    expect(meta.contentType).toBe("application/pdf");
    expect(meta.metadata?.firebaseStorageDownloadTokens).toBe("tok-123");
    expect(meta.metadata?.originalName).toBe("Beleg Übernachtung.pdf");
    const [png2] = await bucket.file(`${PREFIX}/u1/scan.png`).download();
    expect(png2.equals(png)).toBe(true);

    expect((await verifyDump({ dir })).ok).toBe(true);
  });

  it("verification gate fails on corrupted and missing objects", async () => {
    const { importDump, verifyDump } = await loadImport();
    const goodPath = `${PREFIX}/v/good.bin`;
    const corruptPath = `${PREFIX}/v/corrupt.bin`;
    const missingPath = `${PREFIX}/v/missing.bin`;
    const dir = await writeStorageDump([
      { path: goodPath, bytes: Buffer.from("good") },
      { path: corruptPath, bytes: Buffer.from("original") },
      { path: missingPath, bytes: Buffer.from("soon gone") },
    ]);
    await importDump({ dir });
    expect((await verifyDump({ dir })).ok).toBe(true);

    const bucket = getStorage().bucket();
    await bucket.file(corruptPath).save(Buffer.from("bitrot!!"));
    await bucket.file(missingPath).delete();

    const verdict = await verifyDump({ dir });
    expect(verdict.ok).toBe(false);
    expect(verdict.storage.checksumFailures).toContain(corruptPath);
    expect(verdict.storage.missing).toContain(missingPath);
    expect(verdict.storage.checksumFailures).not.toContain(goodPath);
  });

  it("dry-run writes nothing; re-running the import converges", async () => {
    const { importDump } = await loadImport();
    const objPath = `${PREFIX}/idem/a.txt`;
    const bytes = Buffer.from("idempotent");
    const dir = await writeStorageDump([{ path: objPath, bytes }]);
    const bucket = getStorage().bucket();

    const dry = await importDump({ dir, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.storage.objects).toBe(1);
    expect((await bucket.file(objPath).exists())[0]).toBe(false);

    await importDump({ dir });
    await importDump({ dir });
    const [after] = await bucket.file(objPath).download();
    expect(after.equals(bytes)).toBe(true);
  });

  it("round-trip: shim-stored objects export then re-import byte-identical", async () => {
    const { exportDump } = await loadExport();
    const { importDump, verifyDump } = await loadImport();
    const bucket = getStorage().bucket();
    const rtPath = `${PREFIX}/rt/Rechnung Nr. 7.pdf`;
    const bytes = Buffer.from(`round trip ${RUN}`);
    await bucket.file(rtPath).save(bytes, {
      contentType: "application/pdf",
      metadata: { metadata: { firebaseStorageDownloadTokens: "rt-tok" } },
    });

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "w3-storage-rt-"));
    const manifest = await exportDump({ dir, storage: bucket, storagePrefix: `${PREFIX}/rt/` });
    expect(manifest.storage?.count).toBe(1);
    expect(manifest.storage?.bytes).toBe(bytes.length);

    // Destroy, then restore purely from the dump.
    await bucket.file(rtPath).delete();
    await importDump({ dir });
    expect((await verifyDump({ dir })).ok).toBe(true);

    const [restored] = await bucket.file(rtPath).download();
    expect(restored.equals(bytes)).toBe(true);
    const [meta] = await bucket.file(rtPath).getMetadata();
    expect(meta.contentType).toBe("application/pdf");
    expect(meta.metadata?.firebaseStorageDownloadTokens).toBe("rt-tok");
  });
});
