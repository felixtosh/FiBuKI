/**
 * #233: Partner records written before extraction started decoding HTML
 * entities are left holding e.g. "AL&amp;FA Taxi KG". This backfill decodes
 * name and aliases on the calling user's existing Partner records.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, createMockFirestore, createTestPartner } from "../../test/setup";

vi.mock("firebase-admin/firestore", () => {
  return {
    getFirestore: () => createMockFirestore(),
    FieldValue: {
      serverTimestamp: () => new Date("2026-09-10T12:00:00Z"),
    },
  };
});

const { backfillPartnerNameEntitiesCallable } = await import("../backfillPartnerNameEntities");

const userId = "user-1";

function call() {
  return (backfillPartnerNameEntitiesCallable as unknown as {
    run: (r: never) => Promise<{ success: boolean; updated: number; skipped: number }>;
  }).run({ data: {}, auth: { uid: userId } } as never);
}

const partner = (id: string) => store.getDoc("partners", id) as Record<string, unknown>;

beforeEach(() => {
  store.clear();
});

describe("backfillPartnerNameEntitiesCallable", () => {
  it("decodes an entity in the name", async () => {
    store.setDoc("partners", "p1", createTestPartner({ userId, name: "AL&amp;FA Taxi KG" }));

    const result = await call();

    expect(result.success).toBe(true);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(0);
    expect(partner("p1").name).toBe("AL&FA Taxi KG");
  });

  it("decodes entities in aliases", async () => {
    store.setDoc(
      "partners",
      "p1",
      createTestPartner({ userId, name: "Clean Name", aliases: ["AL&amp;FA", "Q &amp; A"] })
    );

    const result = await call();

    expect(result.updated).toBe(1);
    expect(partner("p1").aliases).toEqual(["AL&FA", "Q & A"]);
  });

  it("is idempotent: a record with no entity in name or aliases is skipped", async () => {
    store.setDoc(
      "partners",
      "p1",
      createTestPartner({ userId, name: "Q & A Solutions", aliases: ["AT&T"] })
    );

    const result = await call();

    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(partner("p1").name).toBe("Q & A Solutions");
    expect(partner("p1").aliases).toEqual(["AT&T"]);
  });

  it("only touches the calling user's own partners", async () => {
    store.setDoc(
      "partners",
      "p-other",
      createTestPartner({ userId: "someone-else", name: "AL&amp;FA Taxi KG" })
    );

    const result = await call();

    expect(result.updated).toBe(0);
    expect(partner("p-other").name).toBe("AL&amp;FA Taxi KG");
  });
});
