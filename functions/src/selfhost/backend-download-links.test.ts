/**
 * #206: a backend-written download URL must be retrievable by the UI.
 *
 * `buildDownloadUrl-shim.ts` writes `/__storage/download/<path>` into a
 * document with no token, deliberately: the value is persisted, so a bearer
 * credential in there would land in every backup and would expire within the
 * hour anyway. The consequence is that a plain anchor cannot fetch it, since a
 * browser navigation sends cookies and never an Authorization header. A BMD
 * export, a user-export archive and an issued invoice PDF were all produced and
 * then unretrievable.
 *
 * The existing storage-routes suite pins that property for a CLIENT-minted URL
 * (`getDownloadURL`). This file pins the missing half: that the URL the BACKEND
 * writes resolves against the same route under the same rule, so the contract
 * hooks/use-authenticated-download.ts relies on is tested at the route rather
 * than only at the call site.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createStorageRoutes } from "./storage-routes";
import { _resetStorageForTests, getStorage as adminStorage } from "./storage-shim";
import { buildDownloadUrl } from "./buildDownloadUrl-shim";
import {
  fileNameFromStoredUrl,
  isSelfAuthenticating,
  stripStaleToken,
} from "../../../lib/storage/stored-url";

const GOOD_TOKEN = "tok-felix";
const OBJECT_PATH = "bmd-exports/u1/BMD NTCS 2026-Q1.zip"; // a space, so encoding matters
const PAYLOAD = "PK pretend archive";

let server: http.Server;
let base: string;

beforeAll(async () => {
  process.env.FIBUKI_STORAGE = "memory";
  _resetStorageForTests();

  const app = express();
  app.use(
    "/__storage",
    createStorageRoutes(async (token) => (token === GOOD_TOKEN ? { uid: "felix-test", token: {} } : null)),
  );
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(async () => {
  _resetStorageForTests();
  await adminStorage()
    .bucket()
    .file(OBJECT_PATH)
    .save(Buffer.from(PAYLOAD), { contentType: "application/zip" });
});

/** The URL exactly as the backend writes it, resolved against this test's server. */
function storedUrl(): string {
  process.env.FIBUKI_PUBLIC_URL = base;
  return buildDownloadUrl("ignored-bucket", OBJECT_PATH, "ignored-token");
}

describe("#206 backend-written download links", () => {
  it("the stored URL carries no token, which is why a link navigation fails", async () => {
    const url = storedUrl();
    expect(url).toContain("/__storage/download/");
    expect(url).not.toContain("token=");

    // Exactly what an anchor produces: no Authorization header.
    const asLink = await fetch(url);
    expect(asLink.status).toBe(401);
    const body = await asLink.json();
    expect(body.error.status).toBe("UNAUTHENTICATED");
  });

  it("the same URL fetched with a bearer header returns the bytes", async () => {
    const res = await fetch(storedUrl(), {
      headers: { authorization: `Bearer ${GOOD_TOKEN}` },
    });
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe(PAYLOAD);
  });

  it("a bad token is refused rather than served", async () => {
    const res = await fetch(storedUrl(), { headers: { authorization: "Bearer not-a-token" } });
    expect(res.status).toBe(401);
  });

  it("the route still accepts ?token=, which the fix deliberately does not use", async () => {
    // Pinned so the choice stays a choice: URL-borne credentials leak through
    // Referer, proxy logs and history, so the client sends a header instead.
    const res = await fetch(`${storedUrl()}?token=${GOOD_TOKEN}`);
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe(PAYLOAD);
  });

  it("a stale ?token= is stripped before the header request, so it cannot 401 the fetch", async () => {
    const stale = `${storedUrl()}?token=expired-yesterday`;
    expect((await fetch(stale)).status).toBe(401);

    const repaired = stripStaleToken(stale);
    expect(repaired).not.toContain("token=");
    const res = await fetch(repaired, { headers: { authorization: `Bearer ${GOOD_TOKEN}` } });
    expect(res.ok).toBe(true);
  });

  it("the per-segment encoding survives the round trip, spaces and all", () => {
    const url = storedUrl();
    expect(url).toContain("BMD%20NTCS%202026-Q1.zip");
    expect(fileNameFromStoredUrl(url)).toBe("BMD NTCS 2026-Q1.zip");
  });
});

describe("#206 which stored URLs need credentials", () => {
  it("firebase URLs are left to the browser, so cloud behaviour is untouched", () => {
    expect(
      isSelfAuthenticating(
        "https://firebasestorage.googleapis.com/v0/b/x.appspot.com/o/f.pdf?alt=media&token=abc",
      ),
    ).toBe(true);
    expect(isSelfAuthenticating("https://storage.googleapis.com/bucket/f.pdf")).toBe(true);
    expect(isSelfAuthenticating("blob:https://fibuki.com/1234")).toBe(true);
    expect(isSelfAuthenticating("data:application/pdf;base64,AAA")).toBe(true);
  });

  it("a self-host URL needs credentials, with or without a stale token on it", () => {
    expect(isSelfAuthenticating("/__storage/download/bmd-exports/u1/a.zip")).toBe(false);
    expect(isSelfAuthenticating("https://new-api.fibuki.com/__storage/download/u1/a.zip")).toBe(false);
    // A ?token= URL is NOT trusted: those tokens expire within the hour, so a
    // stored one means a link that silently starts 401ing.
    expect(isSelfAuthenticating("/__storage/download/u1/a.zip?token=whatever")).toBe(false);
  });

  it("stripStaleToken leaves a token-free URL byte-identical, relative or absolute", () => {
    expect(stripStaleToken("/__storage/download/u1/a.zip")).toBe("/__storage/download/u1/a.zip");
    expect(stripStaleToken("https://h/__storage/download/u1/a.zip")).toBe(
      "https://h/__storage/download/u1/a.zip",
    );
    expect(stripStaleToken("/__storage/download/u1/a.zip?token=x")).toBe(
      "/__storage/download/u1/a.zip",
    );
    expect(stripStaleToken("/__storage/download/u1/a.zip?token=x&alt=media")).toBe(
      "/__storage/download/u1/a.zip?alt=media",
    );
  });

  it("a filename falls back sanely when the anchor has no download attribute", () => {
    expect(fileNameFromStoredUrl("/__storage/download/u1/report%20final.pdf")).toBe(
      "report final.pdf",
    );
    // No last segment to take, so the literal fallback is what is left.
    expect(fileNameFromStoredUrl("/__storage/download/")).toBe("download");
    expect(fileNameFromStoredUrl("")).toBe("download");
    // Anything else parses against the relative base and yields its last
    // segment. Never empty, which is all a `download` attribute needs: an empty
    // one makes the browser invent a name like "download.bin".
    expect(fileNameFromStoredUrl("not a url at all")).toBe("not a url at all");
    expect(fileNameFromStoredUrl("archive.zip")).toBe("archive.zip");
  });
});
