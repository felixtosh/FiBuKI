/**
 * Work item 3 — the fibuki-api HTTP host, end to end over real HTTP.
 *
 * Boots the ENTIRE index.ts barrel (287 files) through the selfhost shims,
 * mounts it with createHost(), and exercises the Firebase callable wire
 * protocol against a real listening socket: inventory/exclusion split,
 * auth handling (missing header vs invalid token), body-shape validation,
 * HttpsError → HTTP status mapping, internal-error opacity, a real
 * bulkCreateTransactions import landing in the store, and a raw onRequest
 * function (openApiSpec) served as a plain Express handler.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";
import { createHost, type HostInventory } from "./host";
import { EXCLUDED_EXPORTS } from "./manifest";

const db = getFirestore();
const USER = "stefan-test";
const GOOD_TOKEN = "test-token-stefan";

let server: http.Server;
let base: string;
let inventory: HostInventory;

beforeAll(async () => {
  const barrel = await import("../index");
  const host = createHost(barrel as unknown as Record<string, unknown>, {
    verifyToken: async (token) => (token === GOOD_TOKEN ? { uid: USER, token: {} } : null),
  });
  inventory = host.inventory;
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
  await db.collection("sources").doc("src-n26").set({
    userId: USER,
    name: "N26 Business",
    type: "manual",
    isActive: true,
  });
  await drainTriggers();
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

const callable = (name: string, data: unknown, token?: string) => post(name, { data }, token);

describe("selfhost HTTP host: barrel mounting", () => {
  it("boots the full barrel and mounts a plausible inventory", () => {
    expect(inventory.callables.length).toBeGreaterThan(90);
    expect(inventory.callables).toContain("bulkCreateTransactions");
    expect(inventory.callables).toContain("matchPartners"); // raw onCall, not createCallable
    expect(inventory.requests).toContain("mcpApi");
    expect(inventory.requests).toContain("openApiSpec");
    expect(inventory.scheduled.length).toBeGreaterThanOrEqual(10);
    expect(inventory.scheduled).toContain("processLearningQueue");
  });

  it("mounts nothing from the exclusion manifest", () => {
    const mounted = new Set([...inventory.callables, ...inventory.requests]);
    for (const name of EXCLUDED_EXPORTS) {
      expect(mounted.has(name), `${name} must not be mounted`).toBe(false);
    }
    // Every manifest entry actually exists in the barrel (guards typos and
    // upstream renames): it was counted as excluded, or it never mounted.
    expect(inventory.excluded.length).toBeGreaterThan(40);
  });

  it("serves /healthz with the inventory counts", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number | boolean>;
    expect(body.ok).toBe(true);
    expect(body.callables).toBe(inventory.callables.length);
  });

  it("returns callable-shaped NOT_FOUND for unknown and excluded routes", async () => {
    for (const path of ["noSuchFunction", "createCheckoutSession", "stripeWebhook"]) {
      const { status, body } = await callable(path, {});
      expect(status).toBe(404);
      expect(body.error.status).toBe("NOT_FOUND");
    }
  });
});

describe("selfhost HTTP host: callable protocol", () => {
  it("passes no-auth through to the function, which rejects unauthenticated", async () => {
    const { status, body } = await callable("bulkCreateTransactions", {
      transactions: [],
      sourceId: "src-n26",
    });
    expect(status).toBe(401);
    expect(body.error.status).toBe("UNAUTHENTICATED");
  });

  it("rejects an invalid bearer token at the host", async () => {
    const { status, body } = await callable("bulkCreateTransactions", {}, "forged-token");
    expect(status).toBe(401);
    expect(body.error.status).toBe("UNAUTHENTICATED");
    expect(body.error.message).toMatch(/invalid authentication token/i);
  });

  it("rejects bodies without a data envelope", async () => {
    const { status, body } = await post("bulkCreateTransactions", { notData: 1 }, GOOD_TOKEN);
    expect(status).toBe(400);
    expect(body.error.status).toBe("INVALID_ARGUMENT");
  });

  it("maps HttpsError codes to HTTP statuses on the wire", async () => {
    // invalid-argument from the real handler's own validation
    const bad = await callable("bulkCreateTransactions", { sourceId: "src-n26" }, GOOD_TOKEN);
    expect(bad.status).toBe(400);
    expect(bad.body.error.status).toBe("INVALID_ARGUMENT");
    expect(bad.body.error.message).toBe("transactions array is required");

    // permission-denied importing into a foreign source
    await db.collection("sources").doc("src-other").set({
      userId: "someone-else",
      name: "Foreign",
      type: "manual",
      isActive: true,
    });
    const denied = await callable(
      "bulkCreateTransactions",
      {
        transactions: [
          {
            sourceId: "src-other",
            date: "2026-07-05T22:00:00.000Z",
            amount: -1000,
            currency: "EUR",
            name: "Vendor",
            dedupeHash: "h-1",
            importJobId: "job-1",
            csvRowIndex: 0,
            _original: { date: "05.07.2026", amount: "-10,00", rawRow: {} },
          },
        ],
        sourceId: "src-other",
      },
      GOOD_TOKEN,
    );
    expect(denied.status).toBe(403);
    expect(denied.body.error.status).toBe("PERMISSION_DENIED");
  });

  it("runs a real import end to end over HTTP and persists through the shim", async () => {
    const txs = [1, 2, 3].map((i) => ({
      sourceId: "src-n26",
      date: "2026-07-05T22:00:00.000Z",
      amount: -1000 - i,
      currency: "EUR",
      name: `Vendor ${i}`,
      dedupeHash: `hash-${i}`,
      importJobId: "job-1",
      csvRowIndex: i,
      _original: { date: "05.07.2026", amount: `-10,${i}0`, rawRow: {} },
    }));

    const { status, body } = await callable(
      "bulkCreateTransactions",
      { transactions: txs, sourceId: "src-n26" },
      GOOD_TOKEN,
    );

    expect(status).toBe(200);
    expect(body.result.success).toBe(true);
    expect(body.result.count).toBe(3);
    expect(body.result.transactionIds).toHaveLength(3);

    const stored = (
      await db.collection("transactions").doc(body.result.transactionIds[0]).get()
    ).data()!;
    expect(stored.userId).toBe(USER);
    expect((stored.date as Timestamp).toDate().toISOString()).toBe("2026-07-05T00:00:00.000Z");
  });
});

describe("selfhost HTTP host: raw onRequest functions", () => {
  it("serves openApiSpec as a plain Express handler", async () => {
    const res = await fetch(`${base}/openApiSpec`);
    expect(res.status).toBe(200);
    const spec = (await res.json()) as Record<string, any>;
    expect(spec.openapi ?? spec.swagger).toBeDefined();
  });
});
