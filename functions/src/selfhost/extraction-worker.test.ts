/**
 * The extraction worker (#603): Extraction runs outside the trigger queue,
 * one job per File, claimed round-robin by user, never twice at once.
 *
 * The Extraction itself is a scriptable fake (runExtraction mocked at the
 * extractionCore boundary), so a test can hold a run open for as long as it
 * needs: the "slow Extraction Service" of the acceptance criteria.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import {
  getFirestore,
  Timestamp,
  __rawSqlForTest,
  __resetFirestoreShim,
  __whenShimIdle,
} from "./firestore-shim";
import { drainTriggers, onDocumentCreated } from "./trigger-shim";
import { getTenantId } from "./db/tenant";

const fake = vi.hoisted(() => ({
  /** fileIds in the order their Extraction started. */
  started: [] as string[],
  /** Extractions running right now, and the most seen at once. */
  running: 0,
  maxRunning: 0,
  /** When set, every run waits for it. */
  gate: null as Promise<void> | null,
  /** When set, a run with this fileId throws it. */
  failWith: new Map<string, Error>(),
}));

vi.mock("../extraction/extractionCore", async () => {
  const { getFirestore: db } = await import("./firestore-shim");
  return {
    runExtraction: async (fileId: string) => {
      fake.started.push(fileId);
      fake.running++;
      fake.maxRunning = Math.max(fake.maxRunning, fake.running);
      try {
        if (fake.gate) await fake.gate;
        const error = fake.failWith.get(fileId);
        if (error) throw error;
        await db().collection("files").doc(fileId).update({
          classificationComplete: true,
          extractionComplete: true,
          extractedAmount: 4200,
        });
        return { success: true, duration: 1 };
      } finally {
        fake.running--;
      }
    },
  };
});

import {
  MAX_RECLAIMS,
  claimExtractionJob,
  drainExtractionQueue,
  enqueueExtractionJob,
  reclaimAbandonedExtractions,
  runExtractionJob,
  startExtractionWorker,
} from "./extraction-worker";
import { resweepPendingExtractions } from "./extraction-resweep";
import { retryExtractionForFile } from "../extraction/retryExtractionOps";
import { unmarkFileAsNotInvoice } from "../tools/handlers";
import { unmarkFileAsNotInvoiceCallable } from "../files/unmarkFileAsNotInvoice";
import { markFileAsCopy } from "../files/copyOps";

const db = getFirestore();
const ALICE = "alice";
const BOB = "bob";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function until(cond: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A File as an upload writes it: waiting for its Extraction. */
async function upload(fileId: string, userId: string = ALICE, extra: Record<string, unknown> = {}) {
  await db.collection("files").doc(fileId).set({
    userId,
    fileName: `${fileId}.pdf`,
    storagePath: `uploads/${fileId}.pdf`,
    extractionComplete: false,
    ...extra,
  });
}

async function file(fileId: string): Promise<Record<string, unknown>> {
  return (await db.collection("files").doc(fileId).get()).data()!;
}

async function jobs(): Promise<Record<string, unknown>[]> {
  return (
    await __rawSqlForTest(
      `SELECT file_id, user_id, skip_classification, claimed_at, attempts, rerun
         FROM extraction_jobs ORDER BY created_at, file_id`,
    )
  ).rows;
}

/** A worker that died: its claim is as old as a dead worker's would be. */
async function ageClaims(): Promise<void> {
  await __rawSqlForTest(
    `UPDATE extraction_jobs SET claimed_at = now() - interval '1 hour' WHERE claimed_at IS NOT NULL`,
  );
}

beforeAll(async () => {
  // The upload and undelete triggers, as the barrel registers them.
  await import("../extraction/extractFileData");
});

beforeEach(async () => {
  await drainTriggers(); // nothing a previous case wrote may fire in this one
  await __whenShimIdle();
  await __resetFirestoreShim();
  fake.started.length = 0;
  fake.running = 0;
  fake.maxRunning = 0;
  fake.gate = null;
  fake.failWith.clear();
});

describe("leaving the trigger queue", () => {
  it("an upload only queues a job; other triggers run while uploads wait on a slow Extraction", async () => {
    const gate = deferred();
    fake.gate = gate.promise;
    const worker = startExtractionWorker({ concurrency: 1, intervalMs: 20 });
    try {
      const seen: string[] = [];
      onDocumentCreated("widgets/{id}", (e) => {
        seen.push(e.params.id);
      });

      await upload("f1");
      await upload("f2");
      await upload("f3");
      await db.collection("widgets").doc("w1").set({ n: 1 });

      // The trigger queue drains without waiting for a single Extraction.
      await drainTriggers();
      expect(seen).toEqual(["w1"]);

      await until(() => fake.started.length === 1);
      // One File is being analyzed, the others are queued.
      const analyzing = fake.started[0];
      expect((await file(analyzing)).extractionStartedAt).toBeInstanceOf(Timestamp);
      for (const id of ["f1", "f2", "f3"].filter((x) => x !== analyzing)) {
        expect((await file(id)).extractionStartedAt).toBeUndefined();
        expect((await file(id)).extractionComplete).toBe(false);
      }

      // More triggers keep running on time while the backlog waits.
      await db.collection("widgets").doc("w2").set({ n: 2 });
      await drainTriggers();
      expect(seen).toEqual(["w1", "w2"]);

      gate.resolve();
      await until(async () => (await jobs()).length === 0);
      for (const id of ["f1", "f2", "f3"]) expect((await file(id)).extractionComplete).toBe(true);
      expect(fake.maxRunning).toBe(1);
    } finally {
      await worker.stop();
    }
  });

  it("drops a job whose File was deleted, purged or generated while it waited", async () => {
    await upload("gone");
    await upload("deleted");
    await upload("purged");
    await drainTriggers();
    await db.collection("files").doc("gone").delete();
    await db.collection("files").doc("deleted").update({ deletedAt: Timestamp.now() });
    await db.collection("files").doc("purged").update({ purgedAt: Timestamp.now() });

    expect(await drainExtractionQueue()).toBe(3);
    expect(fake.started).toEqual([]);
    expect(await jobs()).toEqual([]);
  });

  it("a failed Extraction marks the File failed and is not retried by itself", async () => {
    fake.failWith.set("bad", new Error("service said no"));
    await upload("bad");
    await drainTriggers();

    await drainExtractionQueue();
    const doc = await file("bad");
    expect(doc.extractionComplete).toBe(true);
    expect(doc.extractionError).toBe("service said no");
    expect(await jobs()).toEqual([]);
    expect(await drainExtractionQueue()).toBe(0);
  });

  it("marks a File failed at once when its run outlasts the timeout, and holds the claim until the run ends", async () => {
    const gate = deferred();
    fake.gate = gate.promise;
    await upload("slow");
    await drainTriggers();

    const job = (await claimExtractionJob())!;
    const run = runExtractionJob(job, { timeoutMs: 1000, claimWindowMs: 1000 });

    await until(async () => !!(await file("slow")).extractionError, 3000);
    expect((await file("slow")).extractionError).toBe("Extraction did not finish within 1 seconds.");
    // Still one run: the claim is held, nobody else may take the File.
    await reclaimAbandonedExtractions({ claimWindowMs: 1000 });
    expect(await claimExtractionJob()).toBeNull();

    gate.resolve();
    await run;
    expect(await jobs()).toEqual([]);
    expect(fake.started).toEqual(["slow"]);
  });
});

describe("lifting a not-an-invoice mark", () => {
  /** A File as marking it "not an invoice" leaves it: extraction complete, fields cleared. */
  async function markedNotInvoice(fileId: string) {
    await db.collection("files").doc(fileId).set({
      userId: ALICE,
      fileName: `${fileId}.pdf`,
      storagePath: `uploads/${fileId}.pdf`,
      isNotInvoice: true,
      notInvoiceReason: "duplicate re-send",
      classificationComplete: true,
      extractionComplete: true,
      extractedAmount: null,
      transactionIds: [],
    });
    await drainTriggers();
  }

  // No trigger fires on the unmark's write, so each writer queues the
  // Extraction itself; before, these Files sat Queued until the next boot.
  it("the MCP tool queues an Extraction that skips classification, and the worker runs it", async () => {
    await markedNotInvoice("m");
    expect(await jobs()).toHaveLength(0);

    await unmarkFileAsNotInvoice(ALICE, { fileId: "m" });
    await drainTriggers();
    expect(await jobs()).toMatchObject([{ file_id: "m", user_id: ALICE, skip_classification: true }]);

    expect(await drainExtractionQueue()).toBe(1);
    expect(fake.started).toEqual(["m"]);
    expect(await file("m")).toMatchObject({ isNotInvoice: false, extractionComplete: true, extractedAmount: 4200 });
  });

  it("the callable queues it too, so the UI needs no follow-up Retry", async () => {
    await markedNotInvoice("c");

    await (unmarkFileAsNotInvoiceCallable as unknown as { run: (r: unknown) => Promise<unknown> }).run({
      data: { fileId: "c" },
      auth: { uid: ALICE, token: {} },
    });
    await drainTriggers();
    expect(await jobs()).toMatchObject([{ file_id: "c", skip_classification: true }]);

    expect(await drainExtractionQueue()).toBe(1);
    expect(await file("c")).toMatchObject({ extractionComplete: true, extractedAmount: 4200 });
  });

  it("marking a hidden re-send as a Copy queues its Extraction once the transaction commits", async () => {
    await db.collection("files").doc("orig").set({
      userId: ALICE,
      fileName: "orig.pdf",
      extractionComplete: true,
      extractedAmount: 4990,
      transactionIds: [],
    });
    await markedNotInvoice("resend");

    await markFileAsCopy(db as never, ALICE, { fileId: "resend", originalFileId: "orig" }, "user");
    await drainTriggers();
    expect(await jobs()).toMatchObject([{ file_id: "resend", skip_classification: true }]);
    expect(await file("resend")).toMatchObject({ copyOfFileId: "orig", isNotInvoice: false });

    expect(await drainExtractionQueue()).toBe(1);
    expect(fake.started).toEqual(["resend"]);
  });

  it("marking an ordinary File as a Copy queues nothing", async () => {
    await db.collection("files").doc("orig").set({ userId: ALICE, fileName: "orig.pdf", extractionComplete: true, transactionIds: [] });
    await db.collection("files").doc("dup").set({ userId: ALICE, fileName: "dup.pdf", extractionComplete: true, transactionIds: [] });
    await drainTriggers();

    await markFileAsCopy(db as never, ALICE, { fileId: "dup", originalFileId: "orig" }, "user");
    await drainTriggers();
    expect(await jobs()).toHaveLength(0);
  });
});

describe("never twice at once", () => {
  it("keeps a long run's claim fresh past the claim window", async () => {
    const gate = deferred();
    fake.gate = gate.promise;
    await upload("long");
    await drainTriggers();

    const timing = { timeoutMs: 10_000, claimWindowMs: 1000 };
    const job = (await claimExtractionJob())!;
    const run = runExtractionJob(job, timing);

    await sleep(2500); // well past two claim windows
    await reclaimAbandonedExtractions(timing);
    expect(await claimExtractionJob()).toBeNull();
    expect((await jobs())[0].attempts).toBe(0);

    gate.resolve();
    await run;
    expect(fake.started).toEqual(["long"]);
  });

  it("a Retry while the File is queued joins the waiting job", async () => {
    await upload("q", ALICE, { extractionComplete: false });
    await drainTriggers();

    await retryExtractionForFile(db as never, { fileId: "q", userId: ALICE });
    await retryExtractionForFile(db as never, { fileId: "q", userId: ALICE });
    expect(await jobs()).toHaveLength(1);

    expect(await drainExtractionQueue()).toBe(1);
    expect(fake.started).toEqual(["q"]);
  });

  it("a Retry while the File is running runs it again after that run, not alongside it", async () => {
    const gate = deferred();
    fake.gate = gate.promise;
    await upload("r");
    await drainTriggers();

    const worker = startExtractionWorker({ concurrency: 4, intervalMs: 20 });
    try {
      await until(() => fake.started.length === 1);
      await retryExtractionForFile(db as never, { fileId: "r", userId: ALICE });
      expect((await jobs())[0].rerun).toBe(true);
      // "Queued" again: the Retry cleared the start mark.
      expect((await file("r")).extractionStartedAt).toBeNull();

      await sleep(100);
      expect(fake.started).toEqual(["r"]);

      gate.resolve();
      await until(async () => fake.started.length === 2 && (await jobs()).length === 0);
      expect(fake.maxRunning).toBe(1);
    } finally {
      await worker.stop();
    }
  });

  it("two replicas claim each File once", async () => {
    for (let i = 0; i < 6; i++) await upload(`m${i}`, i % 2 ? ALICE : BOB);
    await drainTriggers();

    const a = startExtractionWorker({ concurrency: 2, intervalMs: 10 });
    const b = startExtractionWorker({ concurrency: 2, intervalMs: 10 });
    try {
      await until(async () => (await jobs()).length === 0);
    } finally {
      await Promise.all([a.stop(), b.stop()]);
    }
    expect([...fake.started].sort()).toEqual(["m0", "m1", "m2", "m3", "m4", "m5"]);
  });
});

describe("a worker that died", () => {
  it("is reclaimed, fails the File after three reclaims, and Retry recovers it", async () => {
    await upload("dead");
    await drainTriggers();

    for (let i = 1; i <= MAX_RECLAIMS; i++) {
      expect((await claimExtractionJob())?.fileId).toBe("dead"); // ...and the worker dies
      await ageClaims();
      await reclaimAbandonedExtractions();
      if (i < MAX_RECLAIMS) {
        expect((await jobs())[0]).toMatchObject({ attempts: i, claimed_at: null });
        expect((await file("dead")).extractionError).toBeUndefined();
      }
    }

    const failed = await file("dead");
    expect(failed.extractionComplete).toBe(true);
    expect(failed.extractionError).toBe("Extraction did not finish after 3 attempts.");
    expect(await jobs()).toEqual([]);

    await retryExtractionForFile(db as never, { fileId: "dead", userId: ALICE });
    expect((await jobs())[0]).toMatchObject({ attempts: 0 });
    await drainExtractionQueue();

    const recovered = await file("dead");
    expect(recovered.extractionError).toBeNull();
    expect(recovered.extractionComplete).toBe(true);
    expect(fake.started).toEqual(["dead"]);
  });

  it("a retried job starts its reclaim count over", async () => {
    await upload("again");
    await drainTriggers();
    await claimExtractionJob();
    await ageClaims();
    await reclaimAbandonedExtractions();
    expect((await jobs())[0].attempts).toBe(1);

    await enqueueExtractionJob({ fileId: "again", userId: ALICE, skipClassification: true, kind: "retry" });
    expect((await jobs())[0]).toMatchObject({ attempts: 0, skip_classification: true });

    // A new request yields to the waiting one.
    await enqueueExtractionJob({ fileId: "again", userId: ALICE, skipClassification: false, kind: "new" });
    expect((await jobs())[0]).toMatchObject({ skip_classification: true });
  });
});

describe("a shutdown", () => {
  it("hands running jobs back without counting an attempt", async () => {
    const gate = deferred();
    fake.gate = gate.promise;
    await upload("sd");
    await drainTriggers();

    const worker = startExtractionWorker({ concurrency: 1, intervalMs: 20 });
    await until(() => fake.started.length === 1);
    await worker.stop();
    // A deploy restarts every replica: that must not add up to a failed File.
    expect((await jobs())[0]).toMatchObject({ claimed_at: null, attempts: 0 });

    // The old run ends and leaves alone the job it no longer owns.
    gate.resolve();
    await until(() => fake.running === 0);
    await sleep(50);
    expect(await jobs()).toHaveLength(1);
  });
});

describe("fairness", () => {
  it("serves the user served least recently: a second user's single File beats the first user's backlog", async () => {
    for (const id of ["a1", "a2", "a3"]) await upload(id, ALICE);
    await upload("b1", BOB);
    await drainTriggers();

    await drainExtractionQueue();
    expect(fake.started).toEqual(["a1", "b1", "a2", "a3"]);
  });

  it("remembers whose turn it was across jobs", async () => {
    await upload("a1", ALICE);
    await drainTriggers();
    await drainExtractionQueue();

    // Alice was just served; Bob's File, queued after hers, goes first.
    await upload("a2", ALICE);
    await upload("b1", BOB);
    await drainTriggers();
    await drainExtractionQueue();
    expect(fake.started).toEqual(["a1", "b1", "a2"]);
  });
});

describe("boot resweep", () => {
  it("creates a job for every waiting File that has none, and keeps the jobs that exist", async () => {
    await db.collection("files").doc("old").set({ userId: ALICE, extractionComplete: false });
    await db.collection("files").doc("done").set({ userId: ALICE, extractionComplete: true });
    await db.collection("files").doc("deleted").set({
      userId: ALICE,
      extractionComplete: false,
      deletedAt: Timestamp.now(),
    });
    await db.collection("files").doc("generated").set({
      userId: ALICE,
      extractionComplete: false,
      isFibukiGenerated: true,
    });
    await db.collection("files").doc("queued").set({ userId: BOB, extractionComplete: false });
    // Files from before the queue: their triggers ran, but no job survives.
    await drainTriggers();
    await __rawSqlForTest(`DELETE FROM extraction_jobs`);
    await enqueueExtractionJob({ fileId: "queued", userId: BOB, skipClassification: true, kind: "retry" });

    expect(await resweepPendingExtractions(() => {})).toBe(2);
    const rows = await jobs();
    expect(rows.map((r) => r.file_id).sort()).toEqual(["old", "queued"]);
    // The existing job kept its options.
    expect(rows.find((r) => r.file_id === "queued")).toMatchObject({ skip_classification: true });

    // A second boot changes nothing.
    await resweepPendingExtractions(() => {});
    expect(await jobs()).toHaveLength(2);
  });
});

describe("RLS", () => {
  it("hides the queue from a transaction with no tenant", async () => {
    await upload("hidden");
    await drainTriggers();
    expect((await __rawSqlForTest(`SELECT * FROM extraction_jobs`, [], getTenantId())).rows).toHaveLength(1);
    expect((await __rawSqlForTest(`SELECT * FROM extraction_jobs`, [], null)).rows).toHaveLength(0);
    await drainExtractionQueue();
    expect((await __rawSqlForTest(`SELECT * FROM extraction_turns`, [], null)).rows).toHaveLength(0);
  });
});
