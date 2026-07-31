/**
 * Work item 6, slice C — client firebase/functions shim, driven end-to-end
 * over a real socket against a hand-rolled express app that mimics the
 * callable wire protocol the real host (./host.ts) implements.
 *
 * Proves the shim's job: translate `httpsCallable(fns, name)(data)` into
 * `POST /<name>` with `{ data }` + Bearer auth, unwrap `{ result }` into
 * `{ data }`, and map `{ error: { status, message, details? } }` into a
 * FirebaseError-shaped FunctionsError (`.code`, `.message`, `.name`).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  __configureFunctionsClient,
  getFunctions,
  connectFunctionsEmulator,
  httpsCallable,
  FunctionsError,
} from "../../../lib/selfhost/functions-client";

const GOOD_TOKEN = "tok-stefan";

let server: http.Server;
let base: string;
let receivedAuth: string | undefined;

beforeAll(async () => {
  const app = express();
  app.use(express.json());

  app.post("/echo", (req, res) => {
    receivedAuth = req.headers.authorization;
    res.status(200).json({ result: { ...req.body.data, seen: true } });
  });

  app.post("/needsAuth", (req, res) => {
    if (!req.headers.authorization?.startsWith("Bearer ")) {
      res.status(401).json({ error: { status: "UNAUTHENTICATED", message: "Auth required." } });
      return;
    }
    res.status(200).json({ result: { ok: true } });
  });

  app.post("/boom", (_req, res) => {
    res.status(400).json({ error: { status: "INVALID_ARGUMENT", message: "bad" } });
  });

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  __configureFunctionsClient({ apiUrl: base, getToken: () => GOOD_TOKEN });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("functions-client", () => {
  it("getFunctions() returns an opaque, load-safe handle; connectFunctionsEmulator() is a no-op", () => {
    const fns = getFunctions(undefined, "europe-west1");
    expect(fns).toBeTruthy();
    expect(() => connectFunctionsEmulator(fns, "localhost", 5001)).not.toThrow();
  });

  it("httpsCallable happy path returns { data } and sends the Bearer token", async () => {
    const fns = getFunctions();
    const echo = httpsCallable<{ hello: string }, { hello: string; seen: boolean }>(fns, "echo");
    const result = await echo({ hello: "world" });
    expect(result.data).toEqual({ hello: "world", seen: true });
    expect(receivedAuth).toBe(`Bearer ${GOOD_TOKEN}`);
  });

  it("maps { error: { status: UNAUTHENTICATED } } to code 'unauthenticated'", async () => {
    // needsAuth requires a Bearer header; simulate the unauthenticated path
    // by pointing a client with no token at the same server.
    __configureFunctionsClient({ apiUrl: base, getToken: () => null });
    const fns = getFunctions();
    const needsAuth = httpsCallable(fns, "needsAuth");
    await expect(needsAuth({})).rejects.toMatchObject({ code: "unauthenticated", name: "FirebaseError" });
    // restore the good-token transport for subsequent tests
    __configureFunctionsClient({ apiUrl: base, getToken: () => GOOD_TOKEN });
  });

  it("maps { error: { status: INVALID_ARGUMENT, message } } to code 'invalid-argument' with the server message, name FirebaseError", async () => {
    const fns = getFunctions();
    const boom = httpsCallable(fns, "boom");
    let caught: unknown;
    try {
      await boom({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FunctionsError);
    const err = caught as FunctionsError;
    expect(err.code).toBe("invalid-argument");
    expect(err.message).toBe("bad");
    expect(err.name).toBe("FirebaseError");
  });
});
