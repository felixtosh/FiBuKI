/**
 * The public invoice download, GET /i/{token}/download, driven through the REAL
 * route handler with the web container's admin shim (#372).
 *
 * The route answered a uniform 9-byte 404 for a share whose share doc, invoice,
 * file doc and stored object all existed. The cause was not in the route's lookup
 * chain: fibuki-web had no blob-store configuration, so storage-shim picked its
 * "unconfigured" store, the byte read threw, and the route's catch turned that
 * into the same 404 as a missing share. The share page reads only documents, so
 * it kept working and made the download look like the odd one out.
 *
 * Covered here:
 *   - a valid share streams the stored PDF
 *   - every documented 404 branch answers 404 with the same body
 *   - each 404 is a fresh Response (the old module-level one could be read once)
 *   - an unconfigured blob store is a 404 to the visitor but a distinct,
 *     storage-specific line in the server log
 *   - the compose file gives fibuki-web the same blob store as fibuki-api, which
 *     is the configuration whose absence caused #372
 *
 * Runs against whatever blob store the profile configures (memory locally,
 * SeaweedFS in compose CI). Shared-store rule: every doc id and object path is
 * unique per run.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { getAdminDb, getAdminBucket } from "../../../lib/selfhost/admin-shim";
import { _resetStorageForTests } from "./storage-shim";
import { GET as routeGet } from "../../../app/(public)/i/[token]/download/route";

// The handler takes NextRequest; the route never reads it, so a plain Request does.
const GET = routeGet as unknown as GetHandler;

type GetHandler = (
  req: Request,
  ctx: { params: Promise<{ token: string }> },
) => Promise<Response>;

async function download(token: string): Promise<Response> {
  return GET(new Request(`http://localhost/i/${token}/download`), {
    params: Promise.resolve({ token }),
  });
}

const RUN = randomBytes(4).toString("hex");
const USER = `user-invoice-dl-${RUN}`;
const PDF = Buffer.from(`%PDF-1.4\n% invoice ${RUN}\n%%EOF\n`);

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

interface Fixture {
  token: string;
  storagePath: string;
}

/** share -> invoice -> file -> stored object, each piece overridable. */
async function seed(opts: {
  revoked?: boolean;
  status?: string;
  withFileId?: boolean;
  withFileDoc?: boolean;
  withStoragePath?: boolean;
  withObject?: boolean;
  fileName?: string;
} = {}): Promise<Fixture> {
  const {
    revoked = false,
    status = "issued",
    withFileId = true,
    withFileDoc = true,
    withStoragePath = true,
    withObject = true,
    fileName = "Rechnung-2026-001.pdf",
  } = opts;
  const db = getAdminDb();
  const token = newToken();
  const invoiceId = `inv-${RUN}-${token.slice(0, 8)}`;
  const fileId = `file-${RUN}-${token.slice(0, 8)}`;
  const storagePath = `files/${USER}/invoices/${invoiceId}_v1.pdf`;

  await db.collection("invoiceShares").doc(token).set({
    token,
    invoiceId,
    userId: USER,
    createdAt: new Date(),
    accessCount: 0,
    ...(revoked ? { revokedAt: new Date() } : {}),
  });
  await db.collection("invoices").doc(invoiceId).set({
    userId: USER,
    number: "2026-001",
    status,
    ...(withFileId ? { fileId } : {}),
  });
  if (withFileDoc) {
    await db.collection("files").doc(fileId).set({
      userId: USER,
      fileName,
      fileType: "application/pdf",
      ...(withStoragePath ? { storagePath } : {}),
    });
  }
  if (withObject) {
    await getAdminBucket().file(storagePath).save(PDF, { contentType: "application/pdf" });
  }
  return { token, storagePath };
}

beforeAll(() => {
  // Local runs have no blob store configured; compose CI brings SeaweedFS.
  if (!process.env.FIBUKI_STORAGE && !process.env.FIBUKI_S3_ENDPOINT) {
    process.env.FIBUKI_STORAGE = "memory";
    _resetStorageForTests();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /i/{token}/download", () => {
  it("streams the stored PDF for a valid share", async () => {
    const { token } = await seed({ fileName: "Rechnung Müller.pdf" });

    const res = await download(token);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-length")).toBe(String(PDF.length));
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain('attachment; filename="Rechnung M_ller.pdf"');
    expect(disposition).toContain("filename*=UTF-8''Rechnung%20M%C3%BCller.pdf");
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF)).toBe(true);
  });

  const cases: Array<[string, () => Promise<string>, string]> = [
    ["a short token", async () => "too-short", "malformed-token"],
    ["an unknown token", async () => newToken(), "share-missing"],
    ["a revoked share", async () => (await seed({ revoked: true })).token, "share-revoked"],
    [
      "a cancelled invoice",
      async () => (await seed({ status: "cancelled" })).token,
      "invoice-cancelled",
    ],
    [
      "an invoice without a rendered PDF",
      async () => (await seed({ withFileId: false })).token,
      "invoice-without-file",
    ],
    [
      "a missing file doc",
      async () => (await seed({ withFileDoc: false })).token,
      "file-missing",
    ],
    [
      "a file doc without a storagePath",
      async () => (await seed({ withStoragePath: false })).token,
      "file-without-storage-path",
    ],
    [
      "a stored object that is absent",
      async () => (await seed({ withObject: false })).token,
      "storage-read-failed",
    ],
  ];

  it.each(cases)("answers a uniform 404 for %s, and logs why", async (_label, makeToken, reason) => {
    const token = await makeToken();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await download(token);

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
    const logged = [...warn.mock.calls, ...error.mock.calls].map((c) => String(c[0]));
    expect(logged.some((l) => l.includes(`404 ${reason}`))).toBe(true);
    // The token is the credential: the log carries a prefix at most.
    if (token.length >= 16) {
      expect(logged.some((l) => l.includes(token))).toBe(false);
    }
  });

  it("builds a fresh 404 per request, so every body is readable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await download(newToken());
    const b = await download(newToken());

    expect(a).not.toBe(b);
    expect(await a.text()).toBe("Not found");
    expect(await b.text()).toBe("Not found");
  });

  it("logs an unconfigured blob store as a storage failure, not a missing share (#372)", async () => {
    const { token } = await seed();
    const saved = {
      FIBUKI_STORAGE: process.env.FIBUKI_STORAGE,
      FIBUKI_S3_ENDPOINT: process.env.FIBUKI_S3_ENDPOINT,
    };
    delete process.env.FIBUKI_STORAGE;
    delete process.env.FIBUKI_S3_ENDPOINT;
    _resetStorageForTests();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await download(token);

      expect(res.status).toBe(404);
      expect(await res.text()).toBe("Not found");
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toContain("404 storage-read-failed");
      expect(String(error.mock.calls[0][1])).toContain("no blob store configured");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      _resetStorageForTests();
    }
  });
});

describe("deploy/selfhost/docker-compose.yml", () => {
  const STORAGE_KEYS = [
    "FIBUKI_STORAGE",
    "FIBUKI_S3_ENDPOINT",
    "FIBUKI_S3_PORT",
    "FIBUKI_S3_SSL",
    "FIBUKI_S3_ACCESS_KEY",
    "FIBUKI_S3_SECRET_KEY",
    "FIBUKI_STORAGE_BUCKET",
  ];

  /** The `environment:` mapping of one service, read the same line-based way as
   * scripts/check-web-build-args.js reads its build args. */
  function serviceEnv(service: string): Record<string, string> {
    const compose = fs.readFileSync(
      path.resolve(__dirname, "../../../deploy/selfhost/docker-compose.yml"),
      "utf-8",
    );
    const lines = compose.split("\n");
    const start = lines.findIndex((l) => l === `  ${service}:`);
    if (start === -1) throw new Error(`${service} not found in the compose file`);
    const env: Record<string, string> = {};
    let inEnv = false;
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^ {2}\S/.test(line)) break;
      if (/^ {4}environment:\s*$/.test(line)) {
        inEnv = true;
        continue;
      }
      if (!inEnv) continue;
      if (/^ {4}\S/.test(line)) break;
      const m = line.match(/^ {6}([A-Z0-9_]+):\s*(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
    return env;
  }

  it("gives fibuki-web the same blob store as fibuki-api", () => {
    const api = serviceEnv("fibuki-api");
    const web = serviceEnv("fibuki-web");
    for (const key of STORAGE_KEYS) {
      expect(api[key], `fibuki-api ${key}`).toBeTruthy();
      expect(web[key], `fibuki-web ${key}`).toBe(api[key]);
    }
  });
});
