/**
 * The poll bus is what makes a user's own action feel immediate on a polling
 * backend: a successful write pulls every active onSnapshot listener forward
 * instead of leaving it to wait out its interval (5s in production).
 *
 * Tested at the bus level, plus end-to-end through the real client shim against a
 * real data plane — because the claim that matters is not "the Set works", it is
 * "a write causes a refetch far sooner than the interval would".
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { getFirestore as getServerDb, __resetFirestoreShim } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";
import { createDataPlane } from "./data-plane";
import {
  pokePollers,
  registerPoller,
  __pollerCount,
} from "../../../lib/selfhost/poll-bus";
import {
  __configureFirestoreClient,
  doc,
  onSnapshot,
  setDoc,
  getFirestore,
} from "../../../lib/selfhost/firestore-client";

describe("poll bus: unit", () => {
  it("pokes every registered listener", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = registerPoller(a);
    const offB = registerPoller(b);

    pokePollers();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    offB();
  });

  it("stops poking after unregister, so a torn-down listener cannot leak", () => {
    const fn = vi.fn();
    const before = __pollerCount();
    const off = registerPoller(fn);
    expect(__pollerCount()).toBe(before + 1);

    off();

    expect(__pollerCount()).toBe(before);
    pokePollers();
    expect(fn).not.toHaveBeenCalled();
  });

  it("a throwing listener cannot break the write that triggered the poke", () => {
    const boom = vi.fn(() => {
      throw new Error("subscriber exploded");
    });
    const healthy = vi.fn();
    const off1 = registerPoller(boom);
    const off2 = registerPoller(healthy);

    expect(() => pokePollers()).not.toThrow();
    expect(boom).toHaveBeenCalled();
    expect(healthy).toHaveBeenCalled();

    off1();
    off2();
  });
});

describe("poll bus: end-to-end through the client shim", () => {
  const serverDb = getServerDb();
  const db = getFirestore();
  const USER = "poll-user";
  const GOOD_TOKEN = "tok-poll";
  let server: http.Server;

  beforeAll(async () => {
    const app = express();
    app.use(
      "/__data",
      createDataPlane(async (token) =>
        token === GOOD_TOKEN ? { uid: USER, token: {} } : null,
      ),
    );
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    __configureFirestoreClient({ apiUrl: base, getToken: () => GOOD_TOKEN });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(async () => {
    await __resetFirestoreShim();
    __resetTriggerShim();
  });

  it("a write refreshes an active listener without waiting for the interval", async () => {
    await serverDb.doc("transactions/t1").set({ userId: USER, text: "before" });

    const seen: string[] = [];
    // A deliberately huge interval: if the listener updates during this test, it
    // can only be because the write poked it, never because a timer fired.
    process.env.NEXT_PUBLIC_FIBUKI_POLL_MS = "600000";
    const unsub = onSnapshot(doc(db, "transactions", "t1"), (snap) => {
      const d = snap.data() as { text?: string } | undefined;
      if (d?.text) seen.push(d.text);
    });

    // Wait for the initial (immediate) emission.
    await vi.waitFor(() => expect(seen).toEqual(["before"]), { timeout: 3000 });

    await setDoc(doc(db, "transactions", "t1"), { userId: USER, text: "after" });

    // No timer can have elapsed — 600s — so observing "after" proves the poke.
    await vi.waitFor(() => expect(seen).toEqual(["before", "after"]), { timeout: 3000 });

    unsub();
    delete process.env.NEXT_PUBLIC_FIBUKI_POLL_MS;
  });

  it("unsubscribing deregisters from the bus", async () => {
    process.env.NEXT_PUBLIC_FIBUKI_POLL_MS = "600000";
    const before = __pollerCount();
    const unsub = onSnapshot(doc(db, "transactions", "t2"), () => {});
    expect(__pollerCount()).toBe(before + 1);

    unsub();

    expect(__pollerCount()).toBe(before);
    delete process.env.NEXT_PUBLIC_FIBUKI_POLL_MS;
  });
});
