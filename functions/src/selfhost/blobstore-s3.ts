/**
 * MinIO/S3 BlobStore for the storage shim (work item 5).
 *
 * Env:
 *   FIBUKI_S3_ENDPOINT    host, e.g. "10.30.30.x" or "minio" (required)
 *   FIBUKI_S3_PORT        default 9000
 *   FIBUKI_S3_SSL         "true" to use TLS (default off — VLAN-internal)
 *   FIBUKI_S3_ACCESS_KEY / FIBUKI_S3_SECRET_KEY (required)
 *   FIBUKI_STORAGE_BUCKET bucket name (created at boot if missing)
 *
 * Design notes:
 * - S3 lowercases user-metadata keys, but call sites read camelCase keys
 *   back (`firebaseStorageDownloadTokens`), so custom metadata rides in a
 *   single header (`x-amz-meta-fibuki-custom`) as base64-encoded JSON —
 *   base64 because header values must be ASCII on the wire (raw umlauts in
 *   Gmail attachment filenames would break the V4 signature) and JSON to
 *   preserve key casing.
 * - S3 DELETE is idempotent (204 on missing object); the shim's 404
 *   contract needs a stat first.
 * - S3 can't patch metadata in place; setMeta is a self-copy with
 *   MetadataDirective REPLACE. System headers (Content-Type etc.) must go
 *   via `Headers` there — CopyDestinationOptions.getHeaders() prefixes
 *   every `UserMetadata` key with x-amz-meta-, unlike putObject's header
 *   handling which keeps known system headers unprefixed.
 */

import { Client, CopyDestinationOptions, CopySourceOptions } from "minio";
import type { BlobMetadata, BlobStore } from "./storage-shim";

const CUSTOM_META_KEY = "fibuki-custom";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`selfhost blobstore-s3: ${name} not set`);
  return v;
}

export class S3BlobStore implements BlobStore {
  private client: Client;
  private ready?: Promise<void>;

  constructor(private readonly bucket: string) {
    this.client = new Client({
      endPoint: required("FIBUKI_S3_ENDPOINT"),
      port: parseInt(process.env.FIBUKI_S3_PORT || "9000", 10),
      useSSL: process.env.FIBUKI_S3_SSL === "true",
      accessKey: required("FIBUKI_S3_ACCESS_KEY"),
      secretKey: required("FIBUKI_S3_SECRET_KEY"),
    });
  }

  private ensureBucket(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        if (!(await this.client.bucketExists(this.bucket))) {
          await this.client.makeBucket(this.bucket);
        }
      })().catch((err) => {
        // Don't cache a rejected promise — this is a long-lived server, a
        // transient MinIO outage must not wedge storage until restart.
        this.ready = undefined;
        throw err;
      });
    }
    return this.ready;
  }

  private systemHeaders(meta: BlobMetadata): Record<string, string> {
    // typeof guards: these fields can originate from HTTP input, where a
    // repeated query/header parameter arrives as string[] — never forward
    // a non-string as a header value.
    const h: Record<string, string> = {};
    if (typeof meta.contentType === "string" && meta.contentType) h["Content-Type"] = meta.contentType;
    if (typeof meta.cacheControl === "string" && meta.cacheControl) h["Cache-Control"] = meta.cacheControl;
    if (typeof meta.contentDisposition === "string" && meta.contentDisposition) {
      h["Content-Disposition"] = meta.contentDisposition;
    }
    return h;
  }

  private customHeader(meta: BlobMetadata): Record<string, string> {
    if (!meta.metadata || Object.keys(meta.metadata).length === 0) return {};
    return {
      [CUSTOM_META_KEY]: Buffer.from(JSON.stringify(meta.metadata), "utf8").toString("base64"),
    };
  }

  private fromStat(path: string, stat: {
    size: number;
    lastModified: Date;
    metaData: Record<string, string>;
  }): BlobMetadata {
    const md = stat.metaData ?? {};
    let custom: Record<string, string> | undefined;
    const rawCustom = md[CUSTOM_META_KEY];
    if (rawCustom) {
      try {
        custom = JSON.parse(Buffer.from(rawCustom, "base64").toString("utf8"));
      } catch {
        custom = undefined;
      }
    }
    const updated = stat.lastModified.toISOString();
    return {
      name: path,
      bucket: this.bucket,
      size: String(stat.size),
      contentType: md["content-type"],
      cacheControl: md["cache-control"],
      contentDisposition: md["content-disposition"],
      metadata: custom,
      timeCreated: updated,
      updated,
    };
  }

  async put(path: string, data: Buffer, meta: BlobMetadata): Promise<void> {
    await this.ensureBucket();
    // putObject keeps known system headers unprefixed and x-amz-meta-
    // prefixes only the custom key, so one merged map is correct here.
    await this.client.putObject(this.bucket, path, data, data.length, {
      ...this.systemHeaders(meta),
      ...this.customHeader(meta),
    });
  }

  async head(path: string): Promise<BlobMetadata | null> {
    await this.ensureBucket();
    try {
      const stat = await this.client.statObject(this.bucket, path);
      return this.fromStat(path, stat);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async get(path: string): Promise<{ data: Buffer; meta: BlobMetadata } | null> {
    const meta = await this.head(path);
    if (!meta) return null;
    try {
      const stream = await this.client.getObject(this.bucket, path);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return { data: Buffer.concat(chunks), meta };
    } catch (err) {
      // Deleted between head and get — keep the null/404 contract.
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(path: string): Promise<boolean> {
    const meta = await this.head(path);
    if (!meta) return false;
    await this.client.removeObject(this.bucket, path);
    return true;
  }

  async list(prefix: string): Promise<string[]> {
    await this.ensureBucket();
    const names: string[] = [];
    const stream = this.client.listObjectsV2(this.bucket, prefix, true);
    for await (const obj of stream) {
      if (obj.name) names.push(obj.name);
    }
    return names.sort();
  }

  async setMeta(path: string, meta: BlobMetadata): Promise<void> {
    const existing = await this.head(path);
    if (!existing) {
      throw Object.assign(new Error(`No such object: ${path}`), { code: 404 });
    }
    await this.client.copyObject(
      new CopySourceOptions({ Bucket: this.bucket, Object: path }),
      new CopyDestinationOptions({
        Bucket: this.bucket,
        Object: path,
        UserMetadata: this.customHeader(meta),
        Headers: this.systemHeaders(meta),
        MetadataDirective: "REPLACE",
      }),
    );
  }
}

function isNotFound(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === "NotFound" || code === "NoSuchKey";
}
