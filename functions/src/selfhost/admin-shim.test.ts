/**
 * The server-side Admin SDK swap, driven through REAL application code.
 *
 * `lib/firebase/admin.ts` boots firebase-admin, which authenticates with Google
 * Application Default Credentials. Off GCP there are none, so every module calling
 * getAdminDb() failed with "Could not load the default credentials" — the chat
 * agent's tools, the public invoice share page, precision search, the worker
 * endpoint, Gmail, the auth routes. next.config.ts aliases the module to
 * lib/selfhost/admin-shim.ts; this file aliases it identically (see
 * vitest.selfhost.config.ts) and then exercises it.
 *
 * The claim under test is deliberately NOT "the shim exports the right names".
 * `tsc` cannot check that claim at all — tsconfig paths resolve
 * "@/lib/firebase/admin" to the genuine Firebase module, so the app typechecks
 * against firebase-admin's types no matter what the shim actually implements. A
 * missing method would surface only at runtime, in production, on the one route that
 * used it. So the test drives a real LangChain chat tool end to end against a real
 * (embedded) Postgres and asserts it returns the seeded data.
 */

import { describe, it, expect, beforeAll } from "vitest";

import { getAdminDb, getAdminBucket, getAdminApp } from "../../../lib/selfhost/admin-shim";

const USER = "user-admin-shim";
const TX_ID = "tx-admin-shim-1";

beforeAll(async () => {
  // Seed through the very handle the app will use, so a write/read mismatch shows up
  // here rather than as an empty page in production.
  const db = getAdminDb();
  await db.collection("transactions").doc(TX_ID).set({
    userId: USER,
    amount: -42.5,
    currency: "EUR",
    description: "Admin shim characterization",
    bookingDate: new Date("2026-03-04T00:00:00Z"),
    isComplete: false,
  });
});

describe("admin-shim: the surface app code actually uses", () => {
  it("implements the three db methods the 74 call sites reach for", () => {
    // Measured across app/ and lib/: collection (93), runTransaction (2), batch (2).
    // Nothing else is called on the handle, so this is the whole contract.
    const db = getAdminDb() as unknown as Record<string, unknown>;
    expect(typeof db.collection).toBe("function");
    expect(typeof db.runTransaction).toBe("function");
    expect(typeof db.batch).toBe("function");
  });

  it("round-trips a document", async () => {
    const snap = await getAdminDb().collection("transactions").doc(TX_ID).get();
    expect(snap.exists).toBe(true);
    expect(snap.data()?.description).toBe("Admin shim characterization");
  });

  it("runs a where() query, which is how every list route reads", async () => {
    const res = await getAdminDb()
      .collection("transactions")
      .where("userId", "==", USER)
      .get();
    expect(res.docs.map((d) => d.id)).toContain(TX_ID);
  });

  it("commits a batch", async () => {
    const db = getAdminDb();
    const batch = db.batch();
    batch.update(db.collection("transactions").doc(TX_ID), { isComplete: true });
    await batch.commit();

    const snap = await db.collection("transactions").doc(TX_ID).get();
    expect(snap.data()?.isComplete).toBe(true);
  });

  it("exposes a storage bucket without Google credentials", () => {
    expect(typeof getAdminBucket().file).toBe("function");
  });

  it("returns a marker app rather than throwing — five call sites import it", () => {
    expect(getAdminApp().name).toBe("fibuki-selfhost");
  });
});

describe("admin-shim: a real chat tool, the thing that was broken", () => {
  it("getTransactionTool reads through the shim", async () => {
    // lib/agent/tools/read-tools.ts does `await import("@/lib/firebase/admin")`,
    // which the alias redirects. This is unmodified product code: if the shim's
    // shape were wrong, this throws instead of returning the row.
    const { getTransactionTool } = await import("../../../lib/agent/tools/read-tools");

    const out = await getTransactionTool.invoke(
      { transactionId: TX_ID },
      { configurable: { userId: USER } },
    );

    const text = typeof out === "string" ? out : JSON.stringify(out);
    expect(text).toContain("Admin shim characterization");
  });

  it("scopes reads by user — a tool must not serve another user's row", async () => {
    const { getTransactionTool } = await import("../../../lib/agent/tools/read-tools");

    const out = await getTransactionTool.invoke(
      { transactionId: TX_ID },
      { configurable: { userId: "someone-else" } },
    );

    const text = typeof out === "string" ? out : JSON.stringify(out);
    expect(text).not.toContain("Admin shim characterization");
  });
});
