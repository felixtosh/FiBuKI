/**
 * The deployed host must deliver triggers WITHOUT anything calling
 * drainTriggers() — tests drive drains manually, but production has no such
 * caller, and before enableAutoDrain() existed every trigger (extraction,
 * matching, invoicing) silently queued in memory forever.
 *
 * This file runs in its own vitest fork, so enabling auto-drain here cannot
 * leak into the deterministic manual-drain tests.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, __resetFirestoreShim } from "./firestore-shim";
import { enableAutoDrain } from "./bus";
import { onDocumentCreated, __resetTriggerShim } from "./trigger-shim";
import { resweepPendingExtractions } from "./extraction-resweep";

const db = getFirestore();

function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("condition not met"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

beforeEach(async () => {
  await __resetFirestoreShim();
  __resetTriggerShim();
});

describe("auto-drain", () => {
  it("delivers a created-trigger with no manual drain call", async () => {
    enableAutoDrain();
    const seen: string[] = [];
    onDocumentCreated("widgets/{id}", (e) => {
      seen.push(e.params.id);
    });

    await db.collection("widgets").doc("w1").set({ name: "widget one" });

    // Deliberately NO drainTriggers() — this is the whole point.
    await until(() => seen.includes("w1"));
    expect(seen).toEqual(["w1"]);
  });

  it("delivers a burst longer than one drain slice, not just the first 500", async () => {
    // A CSV import or a boot resweep emits thousands of changes in one go.
    // The manual-drain guard treats >500 as a loop and throws; the deployed
    // host must instead keep going, or everything past the cap is stranded.
    enableAutoDrain();
    const N = 1200;
    const seen = new Set<string>();
    // The fan-out happens INSIDE a handler, i.e. inside one drain — the shape
    // of an import ("N rows written, then re-matched") — so the whole burst
    // sits on the queue at once rather than trickling in between drains.
    onDocumentCreated("imports/{id}", async () => {
      for (let i = 0; i < N; i++) {
        await db.collection("rows").doc(`r${i}`).set({ i });
      }
    });
    onDocumentCreated("rows/{id}", (e) => {
      seen.add(e.params.id);
    });

    await db.collection("imports").doc("imp1").set({});
    await until(() => seen.size === N, 20_000);
    expect(seen.size).toBe(N);
  }, 30_000);

  it("cuts a genuine trigger loop on one document without stalling the others", async () => {
    enableAutoDrain();
    let spins = 0;
    // A handler that rewrites its own document on every change — the loop
    // shape the guard exists for.
    const { onDocumentUpdated } = await import("./trigger-shim");
    onDocumentUpdated("loops/{id}", async (e) => {
      spins++;
      await db.collection("loops").doc(e.params.id).update({ n: spins });
    });
    const seen: string[] = [];
    onDocumentCreated("bystanders/{id}", (e) => {
      seen.push(e.params.id);
    });

    await db.collection("loops").doc("l1").set({ n: 0 });
    await db.collection("loops").doc("l1").update({ n: 1 }); // starts the loop
    await db.collection("bystanders").doc("b1").set({});

    // The bystander created after the loop began must still be delivered, and
    // the loop must have been cut somewhere around the per-path cap rather
    // than running forever.
    await until(() => seen.includes("b1"), 10_000);
    const settled = spins;
    await new Promise((r) => setTimeout(r, 200));
    expect(spins).toBe(settled);
    expect(spins).toBeLessThanOrEqual(110);
  }, 20_000);
});

describe("resweepPendingExtractions", () => {
  it("re-queues only live files awaiting extraction", async () => {
    enableAutoDrain();
    const seen: string[] = [];
    onDocumentCreated("files/{id}", (e) => {
      seen.push(e.params.id);
    });

    await db.collection("files").doc("pending").set({ extractionComplete: false });
    await db.collection("files").doc("done").set({ extractionComplete: true });
    await db.collection("files").doc("deleted").set({ extractionComplete: false, deletedAt: new Date() });
    await db.collection("files").doc("generated").set({ extractionComplete: false, isFibukiGenerated: true });
    // Let the four create-triggers themselves flush first.
    await until(() => seen.length === 4);
    seen.length = 0;

    const n = await resweepPendingExtractions(() => {});
    expect(n).toBe(1);
    await until(() => seen.length === 1);
    expect(seen).toEqual(["pending"]);
  });
});
