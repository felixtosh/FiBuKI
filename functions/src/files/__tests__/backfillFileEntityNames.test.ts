/**
 * #299: file records written before entity normalisation started decoding
 * character references are left holding e.g. "AL&amp;FA Taxi KG" in
 * extractedIssuer/extractedRecipient — the very names identity matching
 * compares against the user's own entity. This backfill decodes them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, createMockFirestore, createTestFile } from "../../test/setup";

// The backfill writes through the File facts module (#640), which stamps its
// writes with a Timestamp rather than a server timestamp.
const BACKFILL_AT = new Date("2026-09-12T12:00:00Z");

vi.mock("firebase-admin/firestore", () => {
  class MockTimestamp {
    constructor(private readonly date: Date) {}
    static fromDate(d: Date) {
      return new MockTimestamp(d);
    }
    static now() {
      return new MockTimestamp(new Date("2026-09-12T12:00:00Z"));
    }
    toDate() {
      return this.date;
    }
    toMillis() {
      return this.date.getTime();
    }
  }
  return {
    getFirestore: () => createMockFirestore(),
    FieldValue: {
      serverTimestamp: () => new Date("2026-09-12T12:00:00Z"),
    },
    Timestamp: MockTimestamp,
  };
});

const { backfillFileEntityNamesCallable } = await import("../backfillFileEntityNames");

const userId = "user-1";

function call() {
  return (backfillFileEntityNamesCallable as unknown as {
    run: (r: never) => Promise<{ success: boolean; updated: number; skipped: number }>;
  }).run({ data: {}, auth: { uid: userId } } as never);
}

const file = (id: string) => store.getDoc("files", id) as Record<string, unknown>;
const entity = (id: string, field: string) =>
  file(id)[field] as Record<string, unknown> | null | undefined;

beforeEach(() => {
  store.clear();
});

describe("backfillFileEntityNamesCallable", () => {
  it("decodes the issuer name and leaves the entity's other fields untouched", async () => {
    store.setDoc(
      "files",
      "f1",
      createTestFile({
        userId,
        extractedIssuer: {
          name: "AL&amp;FA Taxi KG",
          vatId: "ATU12345678",
          iban: "AT021420020010147558",
          address: "Wien",
          website: "alfa-taxi.at",
        },
        extractedRecipient: null,
      })
    );

    const result = await call();

    expect(result.success).toBe(true);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(0);
    expect(entity("f1", "extractedIssuer")).toEqual({
      name: "AL&FA Taxi KG",
      vatId: "ATU12345678",
      iban: "AT021420020010147558",
      address: "Wien",
      website: "alfa-taxi.at",
    });
  });

  it("decodes the recipient name too, and both in one write", async () => {
    store.setDoc(
      "files",
      "f1",
      createTestFile({
        userId,
        extractedIssuer: { name: "Q &amp; A Solutions" },
        extractedRecipient: { name: "AL&#38;FA Taxi KG" },
      })
    );

    const result = await call();

    expect(result.updated).toBe(1);
    expect(entity("f1", "extractedIssuer")?.name).toBe("Q & A Solutions");
    expect(entity("f1", "extractedRecipient")?.name).toBe("AL&FA Taxi KG");
  });

  it("is idempotent: a name with no character reference, bare '&' included, is skipped", async () => {
    store.setDoc(
      "files",
      "f1",
      createTestFile({
        userId,
        extractedIssuer: { name: "Q & A Solutions" },
        extractedRecipient: { name: "AT&T" },
      })
    );

    const result = await call();

    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(entity("f1", "extractedIssuer")?.name).toBe("Q & A Solutions");
    expect(entity("f1", "extractedRecipient")?.name).toBe("AT&T");
  });

  it("skips a file with no entities at all", async () => {
    store.setDoc("files", "f1", createTestFile({ userId }));

    const result = await call();

    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("only touches the calling user's own files", async () => {
    store.setDoc(
      "files",
      "f-other",
      createTestFile({
        userId: "someone-else",
        extractedIssuer: { name: "AL&amp;FA Taxi KG" },
      })
    );

    const result = await call();

    expect(result.updated).toBe(0);
    expect(entity("f-other", "extractedIssuer")?.name).toBe("AL&amp;FA Taxi KG");
  });
});

describe("backfillFileEntityNamesCallable — extractedPartner (#300)", () => {
  it("decodes the flat partner name, so the File agrees with its Partner", async () => {
    // The Partner record as #233's backfill left it: decoded.
    store.setDoc("partners", "p1", { userId, name: "AL&FA Taxi KG" });
    store.setDoc(
      "files",
      "f1",
      createTestFile({ userId, partnerId: "p1", extractedPartner: "AL&amp;FA Taxi KG" })
    );

    const result = await call();

    expect(result.updated).toBe(1);
    expect(file("f1").extractedPartner).toBe("AL&FA Taxi KG");
    expect(file("f1").extractedPartner).toBe(
      (store.getDoc("partners", "p1") as Record<string, unknown>).name
    );
  });

  it("decodes the partner and the entities in one write", async () => {
    store.setDoc(
      "files",
      "f1",
      createTestFile({
        userId,
        extractedPartner: "Q &#38; A Solutions",
        extractedIssuer: { name: "Q &amp; A Solutions" },
      })
    );

    const result = await call();

    expect(result.updated).toBe(1);
    expect(file("f1").extractedPartner).toBe("Q & A Solutions");
    expect(entity("f1", "extractedIssuer")?.name).toBe("Q & A Solutions");
  });

  it("leaves a partner name with a bare '&' byte-identical, and is re-runnable", async () => {
    store.setDoc("files", "f1", createTestFile({ userId, extractedPartner: "AT&T" }));
    store.setDoc("files", "f2", createTestFile({ userId, extractedPartner: "AL&amp;FA Taxi KG" }));
    const untouchedAt = file("f1").updatedAt;

    const first = await call();
    expect(first.updated).toBe(1);
    expect(file("f1").extractedPartner).toBe("AT&T");
    // Not written at all: the backfill's own stamp never reached it.
    expect(file("f1").updatedAt).toEqual(untouchedAt);
    expect(file("f1").lastFactChange).toBeUndefined();
    // The File it did decode carries the stamp. (The mock store turns any
    // Timestamp into "now", so the stamp is read off lastFactChange.)
    const stamp = file("f2").lastFactChange as { origin: string; at: { toDate: () => Date } };
    expect(stamp.origin).toBe("entity-name-backfill");
    expect(stamp.at.toDate()).toEqual(BACKFILL_AT);

    // The second run finds nothing left to decode.
    const second = await call();
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(2);
    expect(file("f2").extractedPartner).toBe("AL&FA Taxi KG");
  });

  it("skips a file whose partner name is not a string", async () => {
    store.setDoc("files", "f1", createTestFile({ userId, extractedPartner: null }));

    const result = await call();

    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
  });
});
