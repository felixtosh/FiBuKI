import { describe, it, expect, afterEach } from "vitest";
import { buildDownloadUrl, buildStorageObjectUrl } from "./buildDownloadUrl";

const BUCKET = "taxstudio-f12fb.firebasestorage.app";

describe("buildDownloadUrl (token form)", () => {
  const saved = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  afterEach(() => {
    if (saved === undefined) delete process.env.FIREBASE_STORAGE_EMULATOR_HOST;
    else process.env.FIREBASE_STORAGE_EMULATOR_HOST = saved;
  });

  it("builds the production firebasestorage URL when no emulator host is set", () => {
    delete process.env.FIREBASE_STORAGE_EMULATOR_HOST;
    expect(buildDownloadUrl(BUCKET, "users/u1/files/a.pdf", "tok123")).toBe(
      `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/users%2Fu1%2Ffiles%2Fa.pdf?alt=media&token=tok123`,
    );
  });

  it("builds the emulator URL when FIREBASE_STORAGE_EMULATOR_HOST is set", () => {
    process.env.FIREBASE_STORAGE_EMULATOR_HOST = "localhost:9199";
    expect(buildDownloadUrl(BUCKET, "users/u1/files/a.pdf", "tok123")).toBe(
      `http://localhost:9199/v0/b/${BUCKET}/o/users%2Fu1%2Ffiles%2Fa.pdf?alt=media&token=tok123`,
    );
  });

  it("percent-encodes the storage path (slashes, spaces, umlauts)", () => {
    delete process.env.FIREBASE_STORAGE_EMULATOR_HOST;
    const url = buildDownloadUrl(BUCKET, "users/u1/Ausgänge 2024.pdf", "t");
    expect(url).toContain("/o/users%2Fu1%2FAusg%C3%A4nge%202024.pdf?alt=media&token=t");
  });
});

describe("buildStorageObjectUrl (plain GCS)", () => {
  it("builds a plain object URL without a query by default", () => {
    expect(buildStorageObjectUrl(BUCKET, "invoices/inv-1.pdf")).toBe(
      `https://storage.googleapis.com/${BUCKET}/invoices/inv-1.pdf`,
    );
  });

  it("appends a cache-busting ?v= when requested", () => {
    const url = buildStorageObjectUrl(BUCKET, "invoices/inv-1.pdf", { cacheBust: true });
    expect(url).toMatch(
      new RegExp(
        `^https://storage\\.googleapis\\.com/${BUCKET.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/invoices/inv-1\\.pdf\\?v=\\d+$`,
      ),
    );
  });
});
