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
