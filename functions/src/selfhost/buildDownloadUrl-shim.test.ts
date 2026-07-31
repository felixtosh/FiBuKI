/**
 * The self-host download-URL shim emits host /__storage/download URLs (matching
 * the client storage shim + the host route), so backend-written links resolve.
 */
import { describe, it, expect, afterEach } from "vitest";
import { buildDownloadUrl, buildStorageObjectUrl } from "./buildDownloadUrl-shim";

describe("buildDownloadUrl-shim", () => {
  const saved = process.env.FIBUKI_PUBLIC_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.FIBUKI_PUBLIC_URL;
    else process.env.FIBUKI_PUBLIC_URL = saved;
  });

  it("buildDownloadUrl emits a host download URL (token dropped, path per-segment encoded)", () => {
    process.env.FIBUKI_PUBLIC_URL = "https://api.fibuki.test/";
    expect(buildDownloadUrl("bucket", "users/u1/Ausgänge 2024.pdf", "storagetoken")).toBe(
      "https://api.fibuki.test/__storage/download/users/u1/Ausg%C3%A4nge%202024.pdf",
    );
  });

  it("buildStorageObjectUrl emits the same host download URL (cacheBust ignored)", () => {
    process.env.FIBUKI_PUBLIC_URL = "https://api.fibuki.test";
    expect(buildStorageObjectUrl("bucket", "invoices/inv-1.pdf", { cacheBust: true })).toBe(
      "https://api.fibuki.test/__storage/download/invoices/inv-1.pdf",
    );
  });

  it("falls back to a root-relative same-origin URL when FIBUKI_PUBLIC_URL is unset", () => {
    delete process.env.FIBUKI_PUBLIC_URL;
    expect(buildDownloadUrl("bucket", "a/b.pdf", "t")).toBe("/__storage/download/a/b.pdf");
    expect(buildStorageObjectUrl("bucket", "a/b.pdf")).toBe("/__storage/download/a/b.pdf");
  });
});
