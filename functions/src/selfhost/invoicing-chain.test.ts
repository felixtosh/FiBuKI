/**
 * Spike test 1 (sanity): the REAL invoicing trigger module runs unmodified
 * on the Postgres-backed shim.
 *
 * Chain under test (see functions/src/invoicing/onFileConnectionWrite.ts):
 *   create fileConnections/{id}  → invoice auto-flips to "paid"
 *   delete fileConnections/{id}  → invoice reverts to "issued"
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim, __registeredTriggers } from "./trigger-shim";

// Importing the REAL trigger module registers its handlers via the aliased
// firebase-functions/v2/firestore → trigger-shim.
import "../invoicing/onFileConnectionWrite";

const db = getFirestore();
const USER = "stefan-test";

beforeEach(async () => {
  await __resetFirestoreShim();
  __resetTriggerShim();
});

describe("selfhost spike: invoicing auto-pay chain on firestore-pg shim", () => {
  it("registered both real triggers from the unmodified module", () => {
    const regs = __registeredTriggers();
    expect(regs).toContainEqual({ type: "created", document: "fileConnections/{connectionId}" });
    expect(regs).toContainEqual({ type: "deleted", document: "fileConnections/{connectionId}" });
  });

  it("auto-pays the invoice when a fileConnection is created", async () => {
    await db.collection("invoices").doc("inv1").set({
      userId: USER,
      status: "issued",
      number: "2026-001",
      createdAt: Timestamp.now(),
    });
    await db.collection("files").doc("f1").set({
      userId: USER,
      fileName: "eingangsrechnung.pdf",
      invoiceId: "inv1",
    });

    await db.collection("fileConnections").doc("c1").set({
      userId: USER,
      fileId: "f1",
      transactionId: "t1",
    });
    await drainTriggers();

    const invoice = (await db.collection("invoices").doc("inv1").get()).data()!;
    expect(invoice.status).toBe("paid");
    expect(invoice.paidByTransactionId).toBe("t1");
    expect(invoice.paidAt).toBeInstanceOf(Timestamp);
  });

  it("reverts the invoice when the fileConnection is deleted", async () => {
    await db.collection("invoices").doc("inv1").set({ userId: USER, status: "issued" });
    await db.collection("files").doc("f1").set({ userId: USER, invoiceId: "inv1" });
    await db.collection("fileConnections").doc("c1").set({
      userId: USER,
      fileId: "f1",
      transactionId: "t1",
    });
    await drainTriggers();
    expect((await db.collection("invoices").doc("inv1").get()).data()!.status).toBe("paid");

    await db.collection("fileConnections").doc("c1").delete();
    await drainTriggers();

    const invoice = (await db.collection("invoices").doc("inv1").get()).data()!;
    expect(invoice.status).toBe("issued");
    expect(invoice.paidByTransactionId).toBeUndefined();
    expect(invoice.paidAt).toBeUndefined();
  });

  it("does not touch invoices in states other than issued/sent", async () => {
    await db.collection("invoices").doc("inv1").set({ userId: USER, status: "draft" });
    await db.collection("files").doc("f1").set({ userId: USER, invoiceId: "inv1" });

    await db.collection("fileConnections").doc("c1").set({
      userId: USER,
      fileId: "f1",
      transactionId: "t1",
    });
    await drainTriggers();

    expect((await db.collection("invoices").doc("inv1").get()).data()!.status).toBe("draft");
  });

  it("ignores files without an invoiceId (regular Belege)", async () => {
    await db.collection("files").doc("f2").set({ userId: USER, fileName: "beleg.pdf" });

    await db.collection("fileConnections").doc("c2").set({
      userId: USER,
      fileId: "f2",
      transactionId: "t2",
    });
    await drainTriggers(); // must not throw

    expect((await db.collection("fileConnections").doc("c2").get()).exists).toBe(true);
  });
});
