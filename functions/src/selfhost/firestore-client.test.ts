/**
 * Work item 6, slice B — client firebase/firestore shim, driven end-to-end
 * against the real slice-A data plane over a socket.
 *
 * Proves the shim's job: translate the SDK surface the app uses
 * (collection/doc/query/where/orderBy/limit/documentId, getDoc(s),
 * add/set/update/delete, writeBatch, runTransaction, onSnapshot=poll,
 * Timestamp, sentinels) into /__data/* calls, round-trip wire values, map
 * server errors to FirebaseError-shaped codes, and fire the SAME trigger bus
 * the backend runs on. Server-side policy is exercised by data-plane.test.ts;
 * here we assert the CLIENT half.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  getFirestore as getServerDb,
  Timestamp as ServerTimestamp,
  __resetFirestoreShim,
} from "./firestore-shim";
import { drainTriggers, __resetTriggerShim, onDocumentCreated } from "./trigger-shim";
import { createDataPlane } from "./data-plane";
import {
  __configureFirestoreClient,
  collection,
  doc,
  query,
  where,
  orderBy,
  limit,
  documentId,
  getDoc,
  getDocs,
  onSnapshot,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  runTransaction,
  serverTimestamp,
  increment,
  arrayUnion,
  arrayRemove,
  deleteField,
  Timestamp,
  FirestoreError,
  getFirestore,
} from "../../../lib/selfhost/firestore-client";

const serverDb = getServerDb();
const db = getFirestore(); // client-shim Firestore handle
const USER = "stefan-test";
const OTHER = "someone-else";
const GOOD_TOKEN = "tok-stefan";

let server: http.Server;

beforeAll(async () => {
  const app = express();
  app.use(
    "/__data",
    createDataPlane(async (token) => {
      if (token === GOOD_TOKEN) return { uid: USER, token: {} };
      return null;
    }),
  );
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  __configureFirestoreClient({ apiUrl: base, getToken: () => GOOD_TOKEN });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 20));
  await __resetFirestoreShim();
  __resetTriggerShim();
});

/** Seed a doc straight through the server shim (bypasses policy/ownership). */
async function seed(path: string, data: Record<string, unknown>): Promise<void> {
  await serverDb.doc(path).set(data);
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}

/* ------------------------------------------------------------------ */

describe("Timestamp class", () => {
  it("is instanceof-safe and round-trips date/millis", () => {
    const ts = Timestamp.fromMillis(1_750_000_000_500);
    expect(ts).toBeInstanceOf(Timestamp);
    expect(ts.toMillis()).toBe(1_750_000_000_500);
    expect(ts.seconds).toBe(1_750_000_000);
    expect(ts.nanoseconds).toBe(500 * 1e6);
    expect(Timestamp.fromDate(new Date(0)).toDate().getTime()).toBe(0);
    expect(Timestamp.now()).toBeInstanceOf(Timestamp);
    expect(ts.isEqual(new Timestamp(1_750_000_000, 500 * 1e6))).toBe(true);
  });
});

describe("reads", () => {
  beforeEach(async () => {
    await seed("transactions/t1", {
      userId: USER, name: "REWE", amount: -1200,
      date: new ServerTimestamp(1_750_000_000, 0), period: { year: 2026 },
    });
    await seed("transactions/t2", {
      userId: USER, name: "Migadu", amount: -1900,
      date: new ServerTimestamp(1_760_000_000, 0), period: { year: 2025 },
    });
    await seed("transactions/t3", { userId: OTHER, name: "Foreign", amount: -1 });
    await drainTriggers();
  });

  it("getDocs injects the owner filter and rehydrates Timestamps as a real class", async () => {
    const snap = await getDocs(collection(db, "transactions"));
    expect(snap.docs.map((d) => d.id).sort()).toEqual(["t1", "t2"]);
    const t1 = snap.docs.find((d) => d.id === "t1")!;
    expect(t1.data().date).toBeInstanceOf(Timestamp);
    expect((t1.data().date as Timestamp).seconds).toBe(1_750_000_000);
    expect(snap.size).toBe(2);
    expect(snap.empty).toBe(false);
  });

  it("translates where (dotted) + orderBy + limit", async () => {
    const q = query(
      collection(db, "transactions"),
      where("period.year", ">=", 2026),
      orderBy("date", "desc"),
      limit(5),
    );
    const snap = await getDocs(q);
    expect(snap.docs.map((d) => d.id)).toEqual(["t1"]);
  });

  it("documentId() in-filter", async () => {
    const snap = await getDocs(
      query(collection(db, "transactions"), where(documentId(), "in", ["t2", "t3", "nope"])),
    );
    // t3 is foreign — the injected owner filter drops it, not just the id list.
    expect(snap.docs.map((d) => d.id)).toEqual(["t2"]);
  });

  it("getDoc: present, missing, and a foreign doc denied as FirebaseError", async () => {
    const present = await getDoc(doc(db, "transactions", "t1"));
    expect(present.exists()).toBe(true);
    expect(present.id).toBe("t1");
    expect(present.data()!.name).toBe("REWE");

    const missing = await getDoc(doc(db, "transactions", "nope"));
    expect(missing.exists()).toBe(false);
    expect(missing.data()).toBeUndefined();

    await expect(getDoc(doc(db, "transactions", "t3"))).rejects.toMatchObject({
      name: "FirebaseError",
      code: "permission-denied",
    });
  });
});

describe("writes", () => {
  it("addDoc returns a ref, decodes sentinels, fires the trigger bus", async () => {
    const fired: string[] = [];
    onDocumentCreated({ document: "partners/{id}" }, async (e) => {
      fired.push(e.params.id);
    });

    const ref = await addDoc(collection(db, "partners"), {
      userId: USER,
      name: "Hetzner",
      createdAt: serverTimestamp(),
      tags: arrayUnion("hosting"),
    });
    expect(ref.id).toBeTruthy();

    await drainTriggers();
    expect(fired).toEqual([ref.id]);

    const stored = (await serverDb.collection("partners").doc(ref.id).get()).data()!;
    expect(stored.name).toBe("Hetzner");
    expect(stored.createdAt).toBeInstanceOf(ServerTimestamp);
    expect(stored.tags).toEqual(["hosting"]);
  });

  it("updateDoc applies increment / arrayRemove / deleteField", async () => {
    await seed("noReceiptCategories/c1", {
      userId: USER, name: "Fees", useCount: 2, examples: ["a", "b"], stale: true,
    });
    await drainTriggers();

    await updateDoc(doc(db, "noReceiptCategories", "c1"), {
      useCount: increment(1),
      examples: arrayRemove("a"),
      stale: deleteField(),
    });

    const stored = (await serverDb.collection("noReceiptCategories").doc("c1").get()).data()!;
    expect(stored.useCount).toBe(3);
    expect(stored.examples).toEqual(["b"]);
    expect("stale" in stored).toBe(false);
  });

  it("setDoc merge patches; a foreign write rejects as permission-denied", async () => {
    await seed("sources/s1", { userId: USER, name: "N26", isActive: true });
    await drainTriggers();
    await setDoc(doc(db, "sources", "s1"), { name: "N26 v2" }, { merge: true });
    const stored = (await serverDb.collection("sources").doc("s1").get()).data()!;
    expect(stored.name).toBe("N26 v2");
    expect(stored.isActive).toBe(true);

    await seed("files/fx", { userId: OTHER, fileName: "x.pdf" });
    await drainTriggers();
    await expect(updateDoc(doc(db, "files", "fx"), { fileName: "mine.pdf" })).rejects.toMatchObject({
      code: "permission-denied",
    });
  });

  it("deleteDoc works through a query snapshot's .ref", async () => {
    await seed("partners/p1", { userId: USER, name: "A" });
    await seed("partners/p2", { userId: USER, name: "B" });
    await drainTriggers();

    const snap = await getDocs(collection(db, "partners"));
    const p1 = snap.docs.find((d) => d.id === "p1")!;
    await deleteDoc(p1.ref);

    const after = await getDocs(collection(db, "partners"));
    expect(after.docs.map((d) => d.id)).toEqual(["p2"]);
  });

  it("writeBatch commits multiple ops atomically", async () => {
    await seed("sources/s1", { userId: USER, name: "N26" });
    await drainTriggers();

    const batch = writeBatch(db);
    batch.update(doc(db, "sources", "s1"), { name: "N26 Business" });
    batch.set(doc(db, "sources", "s2"), { userId: USER, name: "Wise" });
    await batch.commit();

    expect((await serverDb.collection("sources").doc("s1").get()).data()!.name).toBe("N26 Business");
    expect((await serverDb.collection("sources").doc("s2").get()).data()!.name).toBe("Wise");
  });
});

describe("runTransaction (worker-claim seam)", () => {
  it("claims a pending doc, and retries on a raced precondition", async () => {
    await seed(`users/${USER}/workerRequests/wr1`, { status: "pending", task: "sync" });
    await drainTriggers();
    const ref = doc(db, "users", USER, "workerRequests", "wr1");

    // Happy path: read pending -> update to processing.
    const claimed = await runTransaction(db, async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists() || s.data()!.status !== "pending") return false;
      tx.update(ref, { status: "processing" });
      return true;
    });
    expect(claimed).toBe(true);
    expect((await serverDb.doc(`users/${USER}/workerRequests/wr1`).get()).data()!.status).toBe("processing");

    // Race: an external write flips the doc between the tx read and commit on
    // the first attempt, so the ifUnchanged precondition trips -> retry.
    await seed(`users/${USER}/workerRequests/wr2`, { status: "pending", task: "sync" });
    await drainTriggers();
    const ref2 = doc(db, "users", USER, "workerRequests", "wr2");
    let attempts = 0;
    let raced = false;
    const result = await runTransaction(db, async (tx) => {
      attempts++;
      const s = await tx.get(ref2);
      const status = s.data()!.status;
      if (attempts === 1 && !raced) {
        raced = true;
        await serverDb.doc(`users/${USER}/workerRequests/wr2`).set({ status: "processing", task: "sync" });
      }
      if (status !== "pending") return "already-claimed";
      tx.update(ref2, { status: "processing" });
      return "claimed";
    });
    expect(attempts).toBe(2);
    expect(result).toBe("already-claimed");
  });
});

describe("onSnapshot (poll)", () => {
  it("fires on initial load and on subsequent changes, stops on unsubscribe", async () => {
    process.env.NEXT_PUBLIC_FIBUKI_POLL_MS = "40";
    await seed("partners/p1", { userId: USER, name: "A" });
    await drainTriggers();

    const seen: string[][] = [];
    const unsub = onSnapshot(collection(db, "partners"), (snap) => {
      seen.push(snap.docs.map((d: any) => d.id).sort());
    });

    await waitFor(() => seen.length >= 1);
    expect(seen[0]).toEqual(["p1"]);

    await addDoc(collection(db, "partners"), { userId: USER, name: "B" });
    await waitFor(() => seen.some((s) => s.length === 2));
    expect(seen[seen.length - 1].length).toBe(2);

    unsub();
    const countAfterUnsub = seen.length;
    await seed("partners/p3", { userId: USER, name: "C" });
    await new Promise((r) => setTimeout(r, 120));
    expect(seen.length).toBe(countAfterUnsub); // no more callbacks after unsubscribe
    delete process.env.NEXT_PUBLIC_FIBUKI_POLL_MS;
  });

  it("surfaces server errors through the error callback", async () => {
    let err: FirestoreError | null = null;
    const unsub = onSnapshot(
      collection(db, "countryExpansion"), // unlisted -> 403
      () => {},
      (e) => {
        err = e;
      },
    );
    await waitFor(() => err !== null);
    expect(err!.code).toBe("permission-denied");
    unsub();
  });
});
