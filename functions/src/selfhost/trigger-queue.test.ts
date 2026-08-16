/**
 * Cross-process trigger delivery (fork issue #50 / H3).
 *
 * The bug: trigger dispatch rides an in-process bus that only fibuki-api
 * drains, while fibuki-web writes through the same shim. A write made by a web
 * route emitted onto a bus with no listeners — every trigger fed by such a
 * write was dead in deployment, silently, and behaved correctly under test
 * because a test run has one process where a deployment has two.
 *
 * These tests reproduce that boundary in one process by toggling the mode flag:
 * `useDurableTriggerQueue()` puts the shim in fibuki-web's position (writes go
 * to `trigger_events`, nothing dispatches locally), and
 * `__resetTriggerQueueMode()` puts it back in fibuki-api's (the drain runs).
 * That is exactly the split the two containers have.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  getFirestore,
  __resetFirestoreShim,
  __rawSqlForTest,
  Timestamp,
} from "./firestore-shim";
import { getTenantId } from "./db/tenant";
import {
  useDurableTriggerQueue,
  usesDurableTriggerQueue,
  __resetTriggerQueueMode,
} from "./trigger-queue";
import { drainTriggerQueue, drainTriggerQueueOnce } from "./trigger-queue-drain";
import {
  onDocumentCreated,
  onDocumentUpdated,
  onDocumentDeleted,
  __resetTriggerShim,
} from "./trigger-shim";

const db = getFirestore();

/** Rows still queued for the current tenant. */
async function pending(): Promise<Record<string, unknown>[]> {
  const res = await __rawSqlForTest(
    `SELECT seq, collection_path, doc_id, path, before, after, claimed_at, attempts
       FROM trigger_events ORDER BY seq`,
    [],
    getTenantId(),
  );
  return res.rows;
}

/** Run `fn` as if it were executing inside the fibuki-web container. */
async function asWebContainer<T>(fn: () => Promise<T>): Promise<T> {
  useDurableTriggerQueue();
  try {
    return await fn();
  } finally {
    __resetTriggerQueueMode();
  }
}

beforeEach(async () => {
  __resetTriggerQueueMode();
  await __resetFirestoreShim();
  __resetTriggerShim();
});

describe("durable trigger queue", () => {
  it("a web-container write fires no local trigger but is queued", async () => {
    const seen: string[] = [];
    onDocumentCreated("emailIntegrations/{id}", (e) => {
      seen.push(e.params.id);
    });

    await asWebContainer(() =>
      db.collection("emailIntegrations").doc("mig1").set({ provider: "imap" }),
    );

    // The regression this whole change exists for: before the queue, this
    // write vanished from the trigger system entirely and nothing said so.
    expect(seen).toEqual([]);
    const rows = await pending();
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe("emailIntegrations/mig1");
    expect(rows[0].before).toBeNull(); // create
    expect(rows[0].claimed_at).toBeNull();
  });

  it("the dispatching process delivers the queued event and clears the row", async () => {
    const seen: string[] = [];
    onDocumentCreated("emailIntegrations/{id}", (e) => {
      seen.push(e.params.id);
    });

    await asWebContainer(() =>
      db.collection("emailIntegrations").doc("mig1").set({ provider: "imap" }),
    );
    expect(seen).toEqual([]);

    const n = await drainTriggerQueue();

    expect(n).toBe(1);
    expect(seen).toEqual(["mig1"]);
    expect(await pending()).toHaveLength(0);
  });

  it("carries the document through, Timestamps included", async () => {
    const got: Array<Record<string, unknown> | undefined> = [];
    onDocumentCreated("files/{id}", (e) => {
      got.push((e.data as { data: () => Record<string, unknown> }).data());
    });

    const when = Timestamp.fromDate(new Date("2026-08-16T10:00:00.000Z"));
    await asWebContainer(() =>
      db.collection("files").doc("f1").set({ name: "receipt.pdf", uploadedAt: when }),
    );
    await drainTriggerQueue();

    expect(got).toHaveLength(1);
    expect(got[0]?.name).toBe("receipt.pdf");
    // Decoded through the docs codec: a raw jsonb bag here would make every
    // handler's .toDate() throw.
    expect(got[0]?.uploadedAt).toBeInstanceOf(Timestamp);
    expect((got[0]?.uploadedAt as Timestamp).toMillis()).toBe(when.toMillis());
  });

  it("distinguishes create, update and delete", async () => {
    const kinds: string[] = [];
    onDocumentCreated("partners/{id}", () => void kinds.push("created"));
    onDocumentUpdated("partners/{id}", (e) => {
      const change = e.data as {
        before: { data: () => Record<string, unknown> };
        after: { data: () => Record<string, unknown> };
      };
      kinds.push(`updated:${change.before.data()?.name}->${change.after.data()?.name}`);
    });
    onDocumentDeleted("partners/{id}", (e) => {
      kinds.push(`deleted:${(e.data as { data: () => Record<string, unknown> }).data()?.name}`);
    });

    await asWebContainer(async () => {
      await db.collection("partners").doc("p1").set({ name: "old" });
      await db.collection("partners").doc("p1").update({ name: "new" });
      await db.collection("partners").doc("p1").delete();
    });

    expect(await pending()).toHaveLength(3);
    await drainTriggerQueue();

    expect(kinds).toEqual(["created", "updated:old->new", "deleted:new"]);
    expect(await pending()).toHaveLength(0);
  });

  it("delivers in write order", async () => {
    const seen: string[] = [];
    onDocumentCreated("rows/{id}", (e) => void seen.push(e.params.id));

    await asWebContainer(async () => {
      for (let i = 0; i < 5; i++) await db.collection("rows").doc(`r${i}`).set({ i });
    });
    await drainTriggerQueue();

    expect(seen).toEqual(["r0", "r1", "r2", "r3", "r4"]);
  });

  it("keeps a handler's own cascade in-process rather than re-queueing it", async () => {
    // The queue carries the cross-container hop only. A handler runs in the
    // dispatching process, so its writes must take the ordinary in-process
    // path — otherwise every cascade step would pay a queue round trip.
    const seen: string[] = [];
    onDocumentCreated("imports/{id}", async () => {
      await db.collection("transactions").doc("t1").set({ amount: 100 });
    });
    onDocumentCreated("transactions/{id}", (e) => void seen.push(e.params.id));

    await asWebContainer(() => db.collection("imports").doc("imp1").set({ rows: 1 }));
    await drainTriggerQueue();

    expect(seen).toEqual(["t1"]);
    // Only the originating web write was ever queued; the cascade was not.
    expect(await pending()).toHaveLength(0);
  });

  it("drains an empty queue as a no-op", async () => {
    expect(await drainTriggerQueueOnce()).toBe(0);
  });

  it("does not queue writes made by the dispatching process", async () => {
    // fibuki-api still delivers its own writes in-process; queueing them too
    // would dispatch every trigger twice.
    expect(usesDurableTriggerQueue()).toBe(false);
    await db.collection("partners").doc("p9").set({ name: "local" });
    expect(await pending()).toHaveLength(0);
  });

  it("reclaims an event whose dispatcher died mid-handler", async () => {
    const seen: string[] = [];
    onDocumentCreated("files/{id}", (e) => void seen.push(e.params.id));

    await asWebContainer(() => db.collection("files").doc("f1").set({ name: "orphan.pdf" }));

    // Simulate a process that claimed the row and then died: claimed long
    // enough ago that the reclaim window has passed.
    await __rawSqlForTest(
      `UPDATE trigger_events SET claimed_at = now() - interval '30 minutes', attempts = 1`,
      [],
      getTenantId(),
    );
    expect(await drainTriggerQueueOnce()).toBe(1);

    // Reclaimed rather than dropped — the write it describes is committed, so
    // discarding the event would lose the trigger for good.
    expect(seen).toEqual(["f1"]);
    expect(await pending()).toHaveLength(0);
  });

  it("leaves a poison event alone once it has burned its attempts", async () => {
    const seen: string[] = [];
    onDocumentCreated("files/{id}", (e) => void seen.push(e.params.id));

    await asWebContainer(() => db.collection("files").doc("f1").set({ name: "poison.pdf" }));
    await __rawSqlForTest(
      `UPDATE trigger_events SET claimed_at = now() - interval '30 minutes', attempts = 5`,
      [],
      getTenantId(),
    );

    // An event that keeps killing the container must stop being retried, or one
    // bad document starves every other trigger behind it.
    expect(await drainTriggerQueueOnce()).toBe(0);
    expect(seen).toEqual([]);
    expect(await pending()).toHaveLength(1); // parked for inspection, not deleted
  });

  it("scopes queued events to their tenant", async () => {
    // This table holds whole documents, before and after, so it is a richer
    // target than most. db/rls.test.ts checks a hardcoded table list that does
    // not include it, so the policy is asserted here instead.
    await asWebContainer(() =>
      db.collection("partners").doc("p1").set({ name: "tenant A only" }),
    );
    expect(await pending()).toHaveLength(1);

    const other = await __rawSqlForTest(
      `SELECT seq FROM trigger_events`,
      [],
      "00000000-0000-4000-8000-0000000000ff",
    );
    expect(other.rows).toHaveLength(0);
  });

  it("does not block later events behind a parked poison event", async () => {
    const seen: string[] = [];
    onDocumentCreated("files/{id}", (e) => void seen.push(e.params.id));

    await asWebContainer(async () => {
      await db.collection("files").doc("bad").set({ name: "poison.pdf" });
      await db.collection("files").doc("good").set({ name: "fine.pdf" });
    });
    await __rawSqlForTest(
      `UPDATE trigger_events SET claimed_at = now() - interval '30 minutes', attempts = 5
        WHERE doc_id = 'bad'`,
      [],
      getTenantId(),
    );

    await drainTriggerQueue();

    expect(seen).toEqual(["good"]);
  });
});
