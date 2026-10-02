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

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import {
  getFirestore as getServerDb,
  Timestamp as ServerTimestamp,
  __resetFirestoreShim,
  __whenShimIdle,
} from "./firestore-shim";
import { drainTriggers, __resetTriggerShim, onDocumentCreated } from "./trigger-shim";
import { createDataPlane } from "./data-plane";
import {
  __configureFirestoreClient,
  __resetListens,
  __whenListensIdle,
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
import { pokePollers, __resetPokeWindow, setStreamHealthy } from "../../../lib/selfhost/poll-bus";
import { startTestServer, type TestServer } from "./test-helpers";

const serverDb = getServerDb();
const db = getFirestore(); // client-shim Firestore handle
const USER = "stefan-test";
const OTHER = "someone-else";
const GOOD_TOKEN = "tok-stefan";

let server: TestServer;
let baseUrl = "";
/** Every /__data/query body the client sent, in order. */
const queryLog: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  server = await startTestServer((app) => {
    // Logs every query body the client sends, before the data plane answers it.
    app.use("/__data/query", express.json(), (req, _res, next) => {
      queryLog.push(req.body);
      next();
    });
    app.use("/__data", createDataPlane(async (token) => (token === GOOD_TOKEN ? { uid: USER, token: {} } : null)));
  });
  baseUrl = server.base;
  __configureFirestoreClient({ apiUrl: server.base, getToken: () => GOOD_TOKEN });
});

afterAll(() => server.close());

beforeEach(async () => {
  await __whenShimIdle(); // the previous test's fire-and-forget writes, finished
  await __resetFirestoreShim();
  __resetTriggerShim();
  __resetListens();
  __resetPokeWindow();
  setStreamHealthy(false);
  queryLog.length = 0;
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

  // #313: the client and the server shim must agree on what the __name__
  // sentinel reads as, or a cursor built from a client snapshot pages wrong.
  it('snapshot.get("__name__") is the doc id on the client, as on the server shim', async () => {
    const clientDoc = await getDoc(doc(db, "transactions", "t1"));
    const clientQueryDoc = (await getDocs(collection(db, "transactions"))).docs.find((d) => d.id === "t1")!;
    const serverDoc = await serverDb.doc("transactions/t1").get();
    expect(serverDoc.get("__name__")).toBe("t1");
    expect(clientDoc.get("__name__")).toBe(serverDoc.get("__name__"));
    expect(clientQueryDoc.get("__name__")).toBe(serverDoc.get("__name__"));
    // Ordinary field paths are untouched.
    expect(clientDoc.get("period.year")).toBe(serverDoc.get("period.year"));

    const clientMissing = await getDoc(doc(db, "transactions", "nope"));
    const serverMissing = await serverDb.doc("transactions/nope").get();
    expect(clientMissing.get("__name__")).toBe(serverMissing.get("__name__"));
  });

  it("getDoc: present, missing, and a foreign doc that reads exactly like a missing one", async () => {
    const present = await getDoc(doc(db, "transactions", "t1"));
    expect(present.exists()).toBe(true);
    expect(present.id).toBe("t1");
    expect(present.data()!.name).toBe("REWE");

    const missing = await getDoc(doc(db, "transactions", "nope"));
    expect(missing.exists()).toBe(false);
    expect(missing.data()).toBeUndefined();

    // Another user's document: indistinguishable from a missing one, so a
    // held id never confirms that it exists.
    const foreign = await getDoc(doc(db, "transactions", "t3"));
    expect(foreign.exists()).toBe(false);
    expect(foreign.data()).toBeUndefined();
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

  it("setDoc merge patches; a foreign update is refused like a missing one", async () => {
    await seed("sources/s1", { userId: USER, name: "N26", isActive: true });
    await drainTriggers();
    await setDoc(doc(db, "sources", "s1"), { name: "N26 v2" }, { merge: true });
    const stored = (await serverDb.collection("sources").doc("s1").get()).data()!;
    expect(stored.name).toBe("N26 v2");
    expect(stored.isActive).toBe(true);

    await seed("files/fx", { userId: OTHER, fileName: "x.pdf" });
    await drainTriggers();
    await expect(updateDoc(doc(db, "files", "fx"), { fileName: "mine.pdf" })).rejects.toMatchObject({
      code: "not-found",
    });
    await expect(updateDoc(doc(db, "files", "no-such"), { fileName: "mine.pdf" })).rejects.toMatchObject({
      code: "not-found",
    });
    expect((await serverDb.collection("files").doc("fx").get()).data()!.fileName).toBe("x.pdf");
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
    // Pull the (now unsubscribed) listen forward and let it finish: anything
    // it delivered would show up below.
    pokePollers();
    await __whenListensIdle();
    expect(seen.length).toBe(countAfterUnsub); // no more callbacks after unsubscribe
    delete process.env.NEXT_PUBLIC_FIBUKI_POLL_MS;
  });

  /**
   * #124. An exception thrown by the app's own snapshot handler used to be
   * caught by the poller, wrapped in a FirestoreError, and delivered to that
   * same listener's onError — so a crash in application code arrived wearing a
   * FirebaseError name and an error code, reading as "the backend failed".
   * firebase/firestore lets such an exception reach the host environment.
   */
  it("lets an exception from the caller's handler reach the host, not onError", async () => {
    process.env.NEXT_PUBLIC_FIBUKI_POLL_MS = "40";
    await seed("partners/throw1", { userId: USER, name: "A" });

    // Take over uncaughtException for the duration: the rethrow is deliberately
    // unhandled, which is the whole point, and the runner would otherwise fail
    // the file. Capturing it here is also the assertion.
    const runnerListeners = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    const escaped: Error[] = [];
    process.on("uncaughtException", (e) => escaped.push(e as Error));

    let errors = 0;
    let deliveries = 0;
    let unsub: (() => void) | null = null;
    try {
      unsub = onSnapshot(
        collection(db, "partners"),
        () => {
          deliveries++;
          if (deliveries === 1) throw new TypeError("e.createdAt.toDate is not a function");
        },
        () => {
          errors++;
        },
      );
      await waitFor(() => escaped.length >= 1);
    } finally {
      unsub?.();
      process.removeAllListeners("uncaughtException");
      for (const l of runnerListeners) process.on("uncaughtException", l);
      delete process.env.NEXT_PUBLIC_FIBUKI_POLL_MS;
    }

    // The original error, with its own name and message — not a FirestoreError.
    expect(escaped[0]).toBeInstanceOf(TypeError);
    expect(escaped[0].message).toBe("e.createdAt.toDate is not a function");
    expect(escaped[0]).not.toBeInstanceOf(FirestoreError);
    // And nothing was reported as a listen failure.
    expect(errors).toBe(0);
  });

  /**
   * #124, the second half: lastHash was assigned BEFORE next() ran, so a
   * throwing handler still marked the payload consumed. The following tick saw
   * an unchanged hash and returned early, and the listener stayed dark until
   * the data happened to change again.
   */
  it("re-delivers an unchanged payload after the handler throws", async () => {
    process.env.NEXT_PUBLIC_FIBUKI_POLL_MS = "40";
    await seed("partners/retry1", { userId: USER, name: "A" });

    const runnerListeners = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    const escaped: Error[] = [];
    process.on("uncaughtException", (e) => escaped.push(e as Error));

    const received: string[][] = [];
    let attempts = 0;
    let unsub: (() => void) | null = null;
    try {
      unsub = onSnapshot(collection(db, "partners"), (snap) => {
        attempts++;
        if (attempts === 1) throw new TypeError("first delivery explodes");
        received.push(snap.docs.map((d: any) => d.id).sort());
      });
      // Nothing writes to `partners` in between: the only way a second delivery
      // arrives is the poller re-offering the payload it failed to hand over.
      await waitFor(() => received.length >= 1);
    } finally {
      unsub?.();
      process.removeAllListeners("uncaughtException");
      for (const l of runnerListeners) process.on("uncaughtException", l);
      delete process.env.NEXT_PUBLIC_FIBUKI_POLL_MS;
    }

    expect(escaped).toHaveLength(1);
    expect(received[0]).toContain("retry1");
  });

  /**
   * A failed poll sends the listener its error, and app hooks answer that by
   * dropping their data (useFirestoreDoc sets data: null). The next good poll
   * returned the same payload, which deliver() skipped as already sent, so the
   * hook stayed empty until the document changed: the chat showed "Upgrade"
   * to a Pro user whose subscription doc had read as missing.
   */
  it("re-delivers an unchanged payload after a failed poll", async () => {
    process.env.NEXT_PUBLIC_FIBUKI_POLL_MS = "40";
    await seed("partners/recover1", { userId: USER, name: "A" });

    let token = GOOD_TOKEN;
    __configureFirestoreClient({ apiUrl: baseUrl, getToken: () => token });
    let deliveries = 0;
    let errors = 0;
    const unsub = onSnapshot(
      collection(db, "partners"),
      () => {
        deliveries++;
      },
      () => {
        errors++;
      },
    );
    try {
      await waitFor(() => deliveries === 1);
      token = "expired";
      await waitFor(() => errors >= 1);
      token = GOOD_TOKEN;
      await waitFor(() => deliveries === 2);
    } finally {
      unsub();
      __configureFirestoreClient({ apiUrl: baseUrl, getToken: () => GOOD_TOKEN });
      delete process.env.NEXT_PUBLIC_FIBUKI_POLL_MS;
    }
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

/* ------------------------------------------------------------------ */

describe("onSnapshot (shared listens)", () => {
  // A huge interval: anything that changes during these cases was caused by a
  // poke or a join, never by the safety-net timer.
  beforeEach(() => {
    process.env.NEXT_PUBLIC_FIBUKI_POLL_MS = "600000";
  });
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_FIBUKI_POLL_MS;
  });

  const ids = (snap: any): string[] => snap.docs.map((d: any) => d.id);
  const filesQuery = () =>
    query(collection(db, "files"), where("kind", "==", "invoice"), orderBy("uploadedAt", "desc"));
  const deltaRequests = () => queryLog.filter((b) => Array.isArray(b.ids));
  const fullRequests = () => queryLog.filter((b) => !Array.isArray(b.ids));
  /** A change frame, as the realtime stream would deliver it. */
  const frame = (id: string) => {
    __resetPokeWindow();
    pokePollers({ collection: "files", id });
  };

  async function seedFiles(): Promise<void> {
    await seed("files/f1", { userId: USER, kind: "invoice", uploadedAt: 1, name: "one" });
    await seed("files/f2", { userId: USER, kind: "invoice", uploadedAt: 2, name: "two" });
    await seed("files/f3", { userId: USER, kind: "receipt", uploadedAt: 3, name: "three" });
  }

  it("two listeners on one query share one listen and one request", async () => {
    await seedFiles();
    const a: string[][] = [];
    const b: string[][] = [];
    const offA = onSnapshot(filesQuery(), (s) => a.push(ids(s)));
    await waitFor(() => a.length === 1);
    const offB = onSnapshot(filesQuery(), (s) => b.push(ids(s)));
    await waitFor(() => b.length === 1);

    expect(a[0]).toEqual(["f2", "f1"]);
    expect(b[0]).toEqual(["f2", "f1"]);
    // The second listener was answered from the shared listen: no new request.
    expect(fullRequests()).toHaveLength(1);
    offA();
    offB();
  });

  it("a change frame refetches just that document and merges it in place", async () => {
    await seedFiles();
    const seen: any[] = [];
    const off = onSnapshot(filesQuery(), (s) => seen.push(s.docs.map((d: any) => d.data().name)));
    await waitFor(() => seen.length === 1);

    await seed("files/f1", { userId: USER, kind: "invoice", uploadedAt: 1, name: "one, extracted" });
    frame("f1");
    await waitFor(() => seen.length === 2);

    expect(seen[1]).toEqual(["two", "one, extracted"]);
    expect(deltaRequests()).toHaveLength(1);
    expect(deltaRequests()[0].ids).toEqual(["f1"]);
    expect(fullRequests()).toHaveLength(1); // only the initial load
    off();
  });

  it("a document that stops matching is dropped without a full refetch", async () => {
    await seedFiles();
    const seen: string[][] = [];
    const off = onSnapshot(filesQuery(), (s) => seen.push(ids(s)));
    await waitFor(() => seen.length === 1);

    await seed("files/f2", { userId: USER, kind: "receipt", uploadedAt: 2, name: "two" });
    frame("f2");
    await waitFor(() => seen.length === 2);

    expect(seen[1]).toEqual(["f1"]);
    expect(fullRequests()).toHaveLength(1);
    off();
  });

  it("a frame for a document the query never held changes nothing and delivers nothing", async () => {
    await seedFiles();
    const seen: string[][] = [];
    const off = onSnapshot(filesQuery(), (s) => seen.push(ids(s)));
    await waitFor(() => seen.length === 1);

    frame("f3"); // a receipt: not in this query, before or after
    await waitFor(() => deltaRequests().length === 1);
    await __whenListensIdle();

    expect(seen).toHaveLength(1);
    off();
  });

  it("a new member, or a changed sort key, is placed by a full refetch, never by the client", async () => {
    await seedFiles();
    const seen: string[][] = [];
    const off = onSnapshot(filesQuery(), (s) => seen.push(ids(s)));
    await waitFor(() => seen.length === 1);

    // f3 becomes an invoice: a new member, whose position is the server's call.
    await seed("files/f3", { userId: USER, kind: "invoice", uploadedAt: 3, name: "three" });
    frame("f3");
    await waitFor(() => seen.length === 2);
    expect(seen[1]).toEqual(["f3", "f2", "f1"]);

    // f1's sort key moves it to the front.
    await seed("files/f1", { userId: USER, kind: "invoice", uploadedAt: 9, name: "one" });
    frame("f1");
    await waitFor(() => seen.length === 3);
    expect(seen[2]).toEqual(["f1", "f3", "f2"]);

    expect(fullRequests()).toHaveLength(3); // initial + one per server decision
    off();
  });

  it("a listener on another collection is not woken by the frame", async () => {
    await seedFiles();
    await seed("partners/p1", { userId: USER, name: "P" });
    const partners: string[][] = [];
    const off = onSnapshot(collection(db, "partners"), (s) => partners.push(ids(s)));
    await waitFor(() => partners.length === 1);
    const before = queryLog.length;

    frame("f1");
    await __whenListensIdle();

    expect(queryLog.length).toBe(before);
    off();
  });

  it("heals a missed frame on the next full revalidation, and an unchanged result is not resent", async () => {
    await seedFiles();
    const seen: string[][] = [];
    const off = onSnapshot(filesQuery(), (s) => seen.push(ids(s)));
    await waitFor(() => seen.length === 1);

    // A revalidation with nothing changed: answered "unchanged", nothing delivered.
    __resetPokeWindow();
    pokePollers();
    await waitFor(() => fullRequests().length === 2);
    await __whenListensIdle();
    expect(seen).toHaveLength(1);
    expect(typeof fullRequests()[1].ifHash).toBe("string");

    // A change the client is never told about: the frame is lost.
    await seed("files/f4", { userId: USER, kind: "invoice", uploadedAt: 4, name: "four" });
    await __whenListensIdle();
    expect(seen).toHaveLength(1);

    // Any full revalidation (timer, reconnect, tab shown, callable) repairs it.
    __resetPokeWindow();
    pokePollers();
    await waitFor(() => seen.length === 2);
    expect(seen[1]).toEqual(["f4", "f2", "f1"]);
    off();
  });

  it("the generic docs table merges a frame the same way as a flattened table", async () => {
    // noReceiptCategories is not flattened: it lives in the docs table, whose
    // id filter is the `id = ANY(...)` path in firestore-shim.ts.
    await seed("noReceiptCategories/c1", { userId: USER, isActive: true, name: "Bank fees" });
    await seed("noReceiptCategories/c2", { userId: USER, isActive: true, name: "Tips" });
    const q = () =>
      query(collection(db, "noReceiptCategories"), where("isActive", "==", true), orderBy("name", "asc"));
    const seen: string[][] = [];
    const off = onSnapshot(q(), (s) => seen.push(s.docs.map((d: any) => d.data().name)));
    await waitFor(() => seen.length === 1);

    await seed("noReceiptCategories/c2", { userId: USER, isActive: false, name: "Tips" });
    __resetPokeWindow();
    pokePollers({ collection: "noReceiptCategories", id: "c2" });
    await waitFor(() => seen.length === 2);

    expect(seen[1]).toEqual(["Bank fees"]);
    expect(deltaRequests()).toHaveLength(1);
    off();
  });

  it("a frame naming someone else's document never brings it in", async () => {
    await seedFiles();
    await seed("files/foreign", { userId: OTHER, kind: "invoice", uploadedAt: 5, name: "not yours" });
    const seen: string[][] = [];
    const off = onSnapshot(filesQuery(), (s) => seen.push(ids(s)));
    await waitFor(() => seen.length === 1);

    frame("foreign");
    await waitFor(() => deltaRequests().length === 1);
    await __whenListensIdle();

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain("foreign");
    off();
  });

  it("id filters on the docs table intersect, and still honour every other filter", async () => {
    await seed("noReceiptCategories/a", { userId: USER, isActive: true, name: "A" });
    await seed("noReceiptCategories/b", { userId: USER, isActive: false, name: "B" });
    await seed("noReceiptCategories/c", { userId: USER, isActive: true, name: "C" });
    await seed("noReceiptCategories/d", { userId: OTHER, isActive: true, name: "D" });
    const col = collection(db, "noReceiptCategories");

    const inOnly = await getDocs(query(col, where(documentId(), "in", ["a", "b", "d"])));
    expect(inOnly.docs.map((d: any) => d.id).sort()).toEqual(["a", "b"]); // d is not ours

    const both = await getDocs(
      query(col, where(documentId(), "in", ["a", "b", "c"]), where(documentId(), "==", "c")),
    );
    expect(both.docs.map((d: any) => d.id)).toEqual(["c"]);

    const withField = await getDocs(
      query(col, where(documentId(), "in", ["a", "b"]), where("isActive", "==", true)),
    );
    expect(withField.docs.map((d: any) => d.id)).toEqual(["a"]);
  });

  it("the server refuses an unbounded id list", async () => {
    const res = await fetch(`${baseUrl}/__data/query`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${GOOD_TOKEN}` },
      body: JSON.stringify({ path: "files", ids: Array.from({ length: 201 }, (_, i) => `f${i}`) }),
    });
    expect(res.status).toBe(400);
  });

  it("a listener that comes back within the keep-alive window is answered at once, then revalidated", async () => {
    await seedFiles();
    const first: string[][] = [];
    const off1 = onSnapshot(filesQuery(), (s) => first.push(ids(s)));
    await waitFor(() => first.length === 1);
    off1();

    // Changed while nobody was listening and no frame said so.
    await seed("files/f4", { userId: USER, kind: "invoice", uploadedAt: 4, name: "four" });

    const second: string[][] = [];
    const off2 = onSnapshot(filesQuery(), (s) => second.push(ids(s)));
    await waitFor(() => second.length >= 1);
    expect(second[0]).toEqual(["f2", "f1"]); // instant, from the kept result
    await waitFor(() => second.length === 2);
    expect(second[1]).toEqual(["f4", "f2", "f1"]); // and then corrected
    off2();
  });
});
