/**
 * Error surfacing for the shim clients.
 *
 * The bug this pins: behind an HTTP/2 proxy `res.statusText` is always "", and the
 * rate limiter answers 429 in plain text rather than the shim's JSON error shape.
 * Together those produced `FirebaseError` with an empty message and the code
 * "unknown" — the app rendered "Failed to load transactions" with nothing under it.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readHttpError, readXhrError } from "../../../lib/selfhost/http-error";
import {
  __configureFirestoreClient,
  getFirestore,
  collection,
  getDocs,
  FirestoreError,
} from "../../../lib/selfhost/firestore-client";

/** A Response with an empty statusText, exactly as HTTP/2 delivers it. */
function h2Response(status: number, body: string, contentType: string): Response {
  return new Response(body, {
    status,
    statusText: "",
    headers: { "content-type": contentType },
  });
}

describe("readHttpError", () => {
  it("uses a plain-text body when the response is not the JSON error shape", async () => {
    const res = h2Response(429, "Too many requests, please try again later.", "text/plain");
    const { statusCode, message } = await readHttpError(res);
    expect(statusCode).toBe("");
    expect(message).toBe("Too many requests, please try again later.");
  });

  it("prefers the shim's JSON error shape", async () => {
    const res = h2Response(
      403,
      JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "not yours" } }),
      "application/json",
    );
    const { statusCode, message } = await readHttpError(res);
    expect(statusCode).toBe("PERMISSION_DENIED");
    expect(message).toBe("not yours");
  });

  it("falls back to the status code rather than an empty HTTP/2 statusText", async () => {
    const res = h2Response(502, "", "text/plain");
    expect((await readHttpError(res)).message).toBe("HTTP 502");
  });

  it("ignores a proxy's HTML error page", async () => {
    const res = h2Response(504, "<html><body>Gateway Timeout</body></html>", "text/html");
    expect((await readHttpError(res)).message).toBe("HTTP 504");
  });

  it("caps a runaway body", async () => {
    const res = h2Response(500, "x".repeat(5000), "text/plain");
    expect((await readHttpError(res)).message).toHaveLength(200);
  });

  it("survives a body that cannot be read", async () => {
    const res = h2Response(500, "boom", "text/plain");
    await res.text(); // consume it, so the helper's own read throws
    expect((await readHttpError(res)).message).toBe("HTTP 500");
  });

  it("applies the same chain to XMLHttpRequest", () => {
    const xhr = { status: 429, statusText: "", responseText: "slow down" } as XMLHttpRequest;
    expect(readXhrError(xhr, "Upload failed").message).toBe("slow down");

    const blank = { status: 0, statusText: "", responseText: "" } as XMLHttpRequest;
    expect(readXhrError(blank, "Upload failed").message).toBe("Upload failed");
  });
});

describe("firestore client against a rate-limited host", () => {
  let server: http.Server;

  beforeAll(async () => {
    const app = express();
    // What express-rate-limit actually sends: a plain-text 429, no JSON envelope.
    app.use("/__data", (_req, res) => {
      res.status(429).type("text/plain").send("Too many requests, please try again later.");
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    __configureFirestoreClient({ apiUrl: base, getToken: () => "tok" });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("reports 429 as resource-exhausted with the server's reason", async () => {
    const err = await getDocs(collection(getFirestore(), "users/someone/transactions")).catch(
      (e) => e as FirestoreError,
    );
    expect(err).toBeInstanceOf(FirestoreError);
    expect(err.name).toBe("FirebaseError");
    expect(err.code).toBe("resource-exhausted");
    expect(err.message).toBe("Too many requests, please try again later.");
  });
});
