/**
 * #415: the register page reads open seats through the public getOpenSeats
 * callable, over the real self-host HTTP host, without a token. The data
 * plane stays authenticated-only (data-plane.test.ts), so this is the one
 * anonymous path to the seat counts, and it exposes nothing else.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { getFirestore, __resetFirestoreShim } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";
import { createHost } from "./host";
import { getOpenSeatsCallable } from "../auth/getOpenSeats";

const db = getFirestore();
const GOOD_TOKEN = "tok-stefan";

let server: http.Server;
let base: string;

beforeAll(async () => {
  const host = createHost(
    { getOpenSeats: getOpenSeatsCallable },
    { verifyToken: async (t) => (t === GOOD_TOKEN ? { uid: "stefan-test", token: {} } : null) },
  );
  server = http.createServer(host.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 20));
  await __resetFirestoreShim();
  __resetTriggerShim();
});

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${base}/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("getOpenSeats (public callable)", () => {
  it("returns only the seat counts to a caller without a token", async () => {
    await db.collection("config").doc("openSeats").set({
      totalSeats: 10,
      remainingSeats: 3,
      claimedSeats: 7,
      updatedBy: "admin-uid",
      updatedAt: new Date(),
    });
    const r = await post("getOpenSeats", { data: null });
    expect(r.status).toBe(200);
    expect(r.body.result).toEqual({ totalSeats: 10, remainingSeats: 3, claimedSeats: 7 });
  });

  it("returns null when no seats are configured", async () => {
    const r = await post("getOpenSeats", { data: null });
    expect(r.status).toBe(200);
    expect(r.body.result).toBeNull();
  });

  it("serves a signed-in caller too, and rejects a presented bad token", async () => {
    await db.collection("config").doc("openSeats").set({ totalSeats: 5, remainingSeats: 5, claimedSeats: 0 });
    expect((await post("getOpenSeats", { data: null }, GOOD_TOKEN)).body.result.remainingSeats).toBe(5);
    expect((await post("getOpenSeats", { data: null }, "nope")).status).toBe(401);
  });

  it("does not open the data plane: the same doc there still needs a token", async () => {
    await db.collection("config").doc("openSeats").set({ totalSeats: 5, remainingSeats: 5, claimedSeats: 0 });
    expect((await post("__data/get", { path: "config/openSeats" })).status).toBe(401);
    expect((await post("__data/get", { path: "config/pricing" })).status).toBe(401);
  });
});
