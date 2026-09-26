/**
 * #299: file records written before entity normalisation started decoding
 * character references are left holding e.g. "AL&amp;FA Taxi KG" in
 * extractedIssuer/extractedRecipient — the very names identity matching
 * compares against the user's own entity. This backfill decodes them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, createMockFirestore, createTestFile } from "../../test/setup";

vi.mock("firebase-admin/firestore", () => {
  return {
    getFirestore: () => createMockFirestore(),
    FieldValue: {
      serverTimestamp: () => new Date("2026-09-12T12:00:00Z"),
    },
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
