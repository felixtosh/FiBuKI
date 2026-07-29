/**
 * Pins the header routing of the S3 blob store WITHOUT a live MinIO —
 * exactly the seams a live deployment would hit first:
 *
 * - putObject gets one merged header map (minio prefixes only unknown keys),
 * - setMeta's self-copy splits system headers (Headers) from the custom
 *   JSON header (UserMetadata) — CopyDestinationOptions.getHeaders()
 *   x-amz-meta-prefixes EVERY UserMetadata key, so routing Content-Type
 *   through it would corrupt objects on every setMetadata,
 * - custom metadata survives an encode/decode round-trip (base64 keeps
 *   umlaut filenames ASCII-safe on the wire and JSON keeps key casing).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { S3BlobStore } from "./blobstore-s3";
import type { BlobMetadata } from "./storage-shim";

function meta(over: Partial<BlobMetadata> = {}): BlobMetadata {
  return {
    name: "files/u1/a.pdf",
    bucket: "fibuki-test",
    size: "3",
    timeCreated: "2026-07-13T00:00:00.000Z",
    updated: "2026-07-13T00:00:00.000Z",
    ...over,
  };
}

// Private-method access on purpose: these are the pure translation seams.
type Internals = {
  systemHeaders(m: BlobMetadata): Record<string, string>;
  customHeader(m: BlobMetadata): Record<string, string>;
  fromStat(
    path: string,
    stat: { size: number; lastModified: Date; metaData: Record<string, string> },
  ): BlobMetadata;
};

let store: Internals;

beforeAll(() => {
  process.env.FIBUKI_S3_ENDPOINT = "minio.test.invalid";
  process.env.FIBUKI_S3_ACCESS_KEY = "test";
  process.env.FIBUKI_S3_SECRET_KEY = "test";
  store = new S3BlobStore("fibuki-test") as unknown as Internals;
});

describe("S3 blob store header routing (no live MinIO)", () => {
  it("keeps system headers out of the custom-metadata map", () => {
    const m = meta({
      contentType: "application/pdf",
      cacheControl: "private, max-age=0, no-store",
      contentDisposition: 'inline; filename="R-1.pdf"',
      metadata: { firebaseStorageDownloadTokens: "tok-1" },
    });

    expect(store.systemHeaders(m)).toEqual({
      "Content-Type": "application/pdf",
      "Cache-Control": "private, max-age=0, no-store",
      "Content-Disposition": 'inline; filename="R-1.pdf"',
    });

    const custom = store.customHeader(m);
    expect(Object.keys(custom)).toEqual(["fibuki-custom"]);
    // ASCII-only value (header-safe), decodable
    expect(custom["fibuki-custom"]).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("round-trips umlaut filenames and camelCase keys through the custom header", () => {
    const original = {
      originalFilename: "Rechnung Müller & Söhne — Juli.pdf",
      gmailMessageId: "m-äöü-1",
      firebaseStorageDownloadTokens: "tok-2",
    };
    const encoded = store.customHeader(meta({ metadata: original }));

    const roundTripped = store.fromStat("files/u1/a.pdf", {
      size: 3,
      lastModified: new Date("2026-07-13T10:00:00Z"),
      // statObject strips the x-amz-meta- prefix and lowercases keys
      metaData: {
        "content-type": "application/pdf",
        "fibuki-custom": encoded["fibuki-custom"],
      },
    });

    expect(roundTripped.metadata).toEqual(original);
    expect(roundTripped.contentType).toBe("application/pdf");
    expect(roundTripped.size).toBe("3");
  });

  it("omits the custom header entirely when there is no custom metadata", () => {
    expect(store.customHeader(meta())).toEqual({});
    expect(store.customHeader(meta({ metadata: {} }))).toEqual({});
  });
});
