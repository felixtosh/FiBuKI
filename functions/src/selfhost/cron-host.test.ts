/**
 * Work item 4 — the cron host + collectionGroup shim support.
 *
 * Three layers:
 * 1. translateSchedule: every schedule syntax actually used upstream (cron
 *    passthrough + the App Engine forms) plus loud failure on garbage.
 * 2. createCronHost over the REAL index.ts barrel: all scheduled exports
 *    register with correct cron expression + timezone, exclusions respected,
 *    a crashing handler is logged and never throws out of the tick.
 * 3. The load-bearing 5-minute drain end to end: processLearningQueue finds
 *    queues via db.collectionGroup("system") (new shim support, last-path-
 *    segment match), respects the debounce window, drains a ready queue
 *    through the real learnPatternsForPartnersBatch zero-assignment path
 *    (clears patterns + cascade-unassigns auto-matched transactions).
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";
import { createCronHost, translateSchedule, type CronJob } from "./cron-host";

const db = getFirestore();
const USER = "stefan-test";

describe("translateSchedule", () => {
  it("passes real cron expressions through", () => {
    expect(translateSchedule("0 3 * * *")).toBe("0 3 * * *");
    expect(translateSchedule("*/5 * * * *")).toBe("*/5 * * * *");
    expect(translateSchedule("5 0 * * *")).toBe("5 0 * * *");
    expect(translateSchedule("0 8 * * 1")).toBe("0 8 * * 1");
  });

  it("translates App Engine interval syntax", () => {
    expect(translateSchedule("every 5 minutes")).toBe("*/5 * * * *");
    expect(translateSchedule("every 1 minutes")).toBe("*/1 * * * *");
    expect(translateSchedule("every 60 minutes")).toBe("0 * * * *");
    expect(translateSchedule("every 2 hours")).toBe("0 */2 * * *");
    expect(translateSchedule("every 24 hours")).toBe("0 0 * * *");
  });

  it("translates App Engine day-of-week syntax", () => {
    expect(translateSchedule("every monday 03:00")).toBe("0 3 * * 1");
    expect(translateSchedule("every day 04:30")).toBe("30 4 * * *");
    expect(translateSchedule("every sunday 23:59")).toBe("59 23 * * 0");
  });

  it("throws loudly on schedules it cannot translate", () => {
    expect(() => translateSchedule("every full moon")).toThrow(/cannot translate/);
    expect(() => translateSchedule("every 75 minutes")).toThrow(/unsupported minute interval/);
    expect(() => translateSchedule("every day 25:00")).toThrow(/invalid time/);
    expect(() => translateSchedule("not a schedule")).toThrow(/cannot translate/);
  });
});

describe("cron host over the real barrel", () => {
  let jobs: CronJob[];
  let barrel: Record<string, unknown>;
  const byName = (name: string) => jobs.find((j) => j.name === name)!;

  beforeAll(async () => {
    barrel = (await import("../index")) as unknown as Record<string, unknown>;
    const host = createCronHost(barrel);
    jobs = host.jobs;
    await host.stop(); // tasks were never started; free node-cron resources
  });

  it("registers every scheduled export from the barrel", () => {
    expect(jobs.length).toBeGreaterThanOrEqual(10);
    const names = jobs.map((j) => j.name);
    expect(names).toContain("processLearningQueue");
    expect(names).toContain("processOrphanedFiles");
    expect(names).toContain("processGmailSyncQueue");
    expect(names).toContain("processPrecisionSearchQueue");
  });

  it("translates schedule + timezone per job (UTC default, timeZone opt wins)", () => {
    expect(byName("processLearningQueue").cron).toBe("*/5 * * * *");
    expect(byName("processLearningQueue").timezone).toBe("Etc/UTC");
    expect(byName("processGmailSyncQueue").cron).toBe("*/5 * * * *");
    expect(byName("processGmailSyncQueue").timezone).toBe("Europe/Vienna");
  });

  it("respects exclusions", async () => {
    const allNames = new Set(jobs.map((j) => j.name));
    const host = createCronHost(barrel, { exclude: allNames });
    expect(host.jobs).toHaveLength(0);
    await host.stop();
  });

  it("logs a crashing handler instead of throwing out of the tick", async () => {
    const logs: string[] = [];
    const host = createCronHost(
      {
        boom: {
          __selfhostSchedule: { schedule: "every 5 minutes", opts: {} },
          run: async () => {
            throw new Error("kaput");
          },
        },
      },
      { log: (m) => logs.push(m), exclude: new Set() },
    );
    await expect(host.jobs[0].trigger()).resolves.toBeUndefined();
    expect(logs.join("\n")).toContain("cron job boom crashed");
    expect(logs.join("\n")).toContain("kaput");
    await host.stop();
  });
});

describe("firestore shim: collectionGroup", () => {
  beforeEach(async () => {
    await __resetFirestoreShim();
    __resetTriggerShim();
  });

  it("matches subcollections AND top-level collections by last path segment", async () => {
    await db.doc("users/u1/system/learningQueue").set({ status: "idle", tag: "sub1" });
    await db.doc("users/u2/system/learningQueue").set({ status: "idle", tag: "sub2" });
    await db.doc("system/topLevel").set({ status: "idle", tag: "top" });
    await db.doc("users/u1/settings/general").set({ status: "idle", tag: "other-subcol" });
    await db.doc("systemBackup/x").set({ status: "idle", tag: "similar-name" });

    const snap = await db.collectionGroup("system").get();
    const tags = snap.docs.map((d) => d.data()!.tag).sort();
    expect(tags).toEqual(["sub1", "sub2", "top"]);
  });

  it("supports filters and writes back through doc refs at the right path", async () => {
    await db.doc("users/u1/system/learningQueue").set({ pendingPartners: ["p1"], status: "idle" });
    await db.doc("users/u2/system/learningQueue").set({ pendingPartners: [], status: "idle" });
    await db.doc("users/u3/system/learningQueue").set({ pendingPartners: ["p3"], status: "processing" });

    const snap = await db
      .collectionGroup("system")
      .where("pendingPartners", "!=", [])
      .where("status", "==", "idle")
      .get();
    expect(snap.size).toBe(1);
    expect(snap.docs[0].ref.path).toBe("users/u1/system/learningQueue");

    await snap.docs[0].ref.update({ status: "processing" });
    const after = await db.doc("users/u1/system/learningQueue").get();
    expect(after.data()!.status).toBe("processing");
    const untouched = await db.doc("users/u3/system/learningQueue").get();
    expect(untouched.data()!.pendingPartners).toEqual(["p3"]);
  });

  it("rejects paths and empty strings where a collection ID is expected", () => {
    expect(() => db.collectionGroup("users/u1/system")).toThrow(/collection ID/);
    expect(() => db.collectionGroup("")).toThrow(/collection ID/);
  });

  it("treats LIKE wildcard characters in collection IDs literally", async () => {
    await db.doc("users/u1/my_group/d1").set({ tag: "underscore" });
    await db.doc("users/u1/myXgroup/d1").set({ tag: "x-not-wildcard" });

    const snap = await db.collectionGroup("my_group").get();
    expect(snap.docs.map((d) => d.data()!.tag)).toEqual(["underscore"]);
  });
});

describe("processLearningQueue drain (the load-bearing 5-minute cron)", () => {
  let processQueue: () => Promise<void>;

  beforeAll(async () => {
    const barrel = (await import("../index")) as unknown as Record<string, unknown>;
    const host = createCronHost(barrel);
    const job = host.jobs.find((j) => j.name === "processLearningQueue")!;
    processQueue = job.trigger;
    await host.stop();
  });

  beforeEach(async () => {
    await __resetFirestoreShim();
    __resetTriggerShim();
    await db.collection("partners").doc("p1").set({
      userId: USER,
      name: "Acme GmbH",
      learnedPatterns: [{ pattern: "acme", confidence: 95 }],
    });
    // Auto-assigned transaction: must be cascade-unassigned when the drain
    // clears patterns (partner has zero user assignments).
    await db.collection("transactions").doc("t1").set({
      userId: USER,
      partnerId: "p1",
      partnerMatchedBy: "auto",
      partnerType: "user",
      name: "ACME GMBH 2026-07",
      amount: -49.9,
    });
    await drainTriggers();
  });

  const queueRef = () => db.doc(`users/${USER}/system/learningQueue`);

  it("drains a ready queue: clears patterns, cascade-unassigns, resets the queue doc", async () => {
    await queueRef().set({
      pendingPartners: ["p1"],
      queuedAt: Timestamp.fromMillis(Date.now() - 10 * 60 * 1000),
      processAfter: Timestamp.fromMillis(Date.now() - 5 * 60 * 1000),
      status: "idle",
      userId: USER,
    });
    await drainTriggers();

    await processQueue();
    await drainTriggers();

    const queue = (await queueRef().get()).data()!;
    expect(queue.status).toBe("idle");
    expect(queue.pendingPartners).toEqual([]);
    expect(queue.processAfter).toBeUndefined();

    const partner = (await db.collection("partners").doc("p1").get()).data()!;
    expect(partner.learnedPatterns).toEqual([]);
    expect(partner.patternsUpdatedAt).toBeInstanceOf(Timestamp);

    const tx = (await db.collection("transactions").doc("t1").get()).data()!;
    expect(tx.partnerId).toBeNull();
    expect(tx.partnerMatchedBy).toBeNull();
    expect(tx.automationHistory).toHaveLength(1);
    expect(tx.automationHistory[0].type).toBe("partner_removed");
  });

  it("respects the debounce window (processAfter in the future)", async () => {
    await queueRef().set({
      pendingPartners: ["p1"],
      queuedAt: Timestamp.now(),
      processAfter: Timestamp.fromMillis(Date.now() + 5 * 60 * 1000),
      status: "idle",
      userId: USER,
    });
    await drainTriggers();

    await processQueue();
    await drainTriggers();

    const queue = (await queueRef().get()).data()!;
    expect(queue.pendingPartners).toEqual(["p1"]);
    expect(queue.status).toBe("idle");
    const partner = (await db.collection("partners").doc("p1").get()).data()!;
    expect(partner.learnedPatterns).toEqual([{ pattern: "acme", confidence: 95 }]);
  });

  it("skips queues already marked processing", async () => {
    await queueRef().set({
      pendingPartners: ["p1"],
      queuedAt: Timestamp.now(),
      processAfter: Timestamp.fromMillis(Date.now() - 60 * 1000),
      status: "processing",
      userId: USER,
    });
    await drainTriggers();

    await processQueue();
    await drainTriggers();

    const queue = (await queueRef().get()).data()!;
    expect(queue.pendingPartners).toEqual(["p1"]);
    expect(queue.status).toBe("processing");
  });
});
