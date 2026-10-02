/**
 * Shared helpers for selfhost shim tests.
 */

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { drainTriggers } from "./trigger-shim";
import { createDataPlane } from "./data-plane";

/**
 * Poll until cond() holds, draining trigger queues between checks. Needed
 * for fire-and-forget branches (reconciliation, receipt search, usage
 * logging) that application handlers intentionally do not await.
 */
export async function waitFor(cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    await drainTriggers();
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * An HTTP server on a free local port with whatever the test mounts, and its
 * base URL. The setup seven test files used to repeat (express, listen on
 * port 0, read the address back, close on the way out), in one place.
 */
export interface TestServer {
  base: string;
  close(): Promise<void>;
}

export async function startTestServer(mount: (app: express.Express) => void): Promise<TestServer> {
  const app = express();
  mount(app);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

/** The client data plane at /__data, authenticated by `verify`. */
export function startTestDataPlane(
  verify: (token: string) => Promise<{ uid: string; token?: Record<string, unknown> } | null>,
): Promise<TestServer> {
  return startTestServer((app) => {
    app.use("/__data", createDataPlane(verify as never));
  });
}
