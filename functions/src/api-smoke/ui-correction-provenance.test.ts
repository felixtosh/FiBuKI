/**
 * The UI correction path leaves provenance (#149).
 *
 * The file detail panel's save — `components/files/file-detail-panel`
 * → `updateFileExtractedFields` in lib/operations/file-ops — used to build its
 * own update map and `updateDoc` it straight to Firestore. The provenance stamp
 * #147 introduced is written inside `buildExtractionCorrection`, which only the
 * MCP tool went through, so a correction typed by a person was re-rolled by the
 * next `retry_file_extraction` while an agent's was protected — and the UI is
 * the common case.
 *
 * What is asserted here is the shape of the fix: the operation delegates to the
 * callable and writes nothing itself, and the payload it hands over is typed
 * (cents, an ISO date, normalised items) so the server can compare it against
 * what is stored. Which fields the callable then stamps is covered by
 * functions/src/files/__tests__/updateFileExtractedFields, and the comparison
 * itself by …/extraction-moved-fields. A second client-side writer is what this
 * test exists to catch.
 *
 * Covers repo-root lib/, so it runs under vitest.api-smoke.config.ts ONLY
 * (needs root node_modules for the browser Firebase SDK).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { httpsCallableMock, callableInvoke } = vi.hoisted(() => ({
  httpsCallableMock: vi.fn(),
  callableInvoke: vi.fn(async () => ({
    data: { success: true, changed: ["amount"], correctedFields: ["amount"] },
  })),
}));

vi.mock("firebase/functions", () => ({
  httpsCallable: (...args: unknown[]) => {
    httpsCallableMock(...args);
    return callableInvoke;
  },
}));

vi.mock("@/lib/firebase/config", () => ({ functions: {}, db: {}, auth: {} }));

const { updateDoc, getDoc, getDocs, writeBatch } = vi.hoisted(() => ({
  updateDoc: vi.fn(),
  getDoc: vi.fn(async () => ({ exists: () => true, id: "file-1", data: () => ({ userId: "user-1" }) })),
  getDocs: vi.fn(),
  writeBatch: vi.fn(() => ({ update: vi.fn(), set: vi.fn(), commit: vi.fn() })),
}));

vi.mock("firebase/firestore", () => ({
  collection: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  orderBy: vi.fn(),
  limit: vi.fn(),
  doc: vi.fn(() => ({ id: "file-doc-ref" })),
  arrayUnion: vi.fn(),
  arrayRemove: vi.fn(),
  deleteField: vi.fn(),
  getDoc: (...args: unknown[]) => getDoc(...args),
  getDocs: (...args: unknown[]) => getDocs(...args),
  updateDoc: (...args: unknown[]) => updateDoc(...args),
  deleteDoc: vi.fn(),
  setDoc: vi.fn(),
  addDoc: vi.fn(),
  writeBatch: (...args: unknown[]) => writeBatch(...args),
  serverTimestamp: vi.fn(),
  onSnapshot: vi.fn(),
  Timestamp: {
    now: () => ({ toDate: () => new Date(0) }),
    fromDate: (d: Date) => ({ toDate: () => d }),
  },
}));

import { updateFileExtractedFields } from "@/lib/operations/file-ops";

const ctx = { db: {}, userId: "user-1" } as unknown as Parameters<
  typeof updateFileExtractedFields
>[0];

/** What the panel hands over: every box on the form, as typed. */
function form(overrides: Record<string, unknown> = {}) {
  return {
    date: "2026-03-04",
    amount: "3180,00",
    vatPercent: "20",
    partner: "ACME GmbH",
    vatId: "ATU12345678",
    iban: "",
    address: "",
    additionalFields: [],
    ...overrides,
  } as Parameters<typeof updateFileExtractedFields>[2];
}

const payload = () => callableInvoke.mock.calls[0][0] as unknown as {
  fileId: string;
  correction: Record<string, unknown>;
  details: Record<string, unknown>;
};

describe("updateFileExtractedFields (client operation)", () => {
  beforeEach(() => {
    httpsCallableMock.mockClear();
    callableInvoke.mockClear();
    updateDoc.mockClear();
    getDoc.mockClear();
    writeBatch.mockClear();
  });

  it("delegates to the updateFileExtractedFields callable", async () => {
    await updateFileExtractedFields(ctx, "file-1", form());

    expect(httpsCallableMock).toHaveBeenCalledTimes(1);
    expect(httpsCallableMock.mock.calls[0][1]).toBe("updateFileExtractedFields");
    expect(payload().fileId).toBe("file-1");
  });

  it("writes nothing to Firestore from the client", async () => {
    await updateFileExtractedFields(ctx, "file-1", form());

    expect(updateDoc).not.toHaveBeenCalled();
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it("sends the correctable values typed, so the server can compare them", async () => {
    await updateFileExtractedFields(ctx, "file-1", form());

    expect(payload().correction).toMatchObject({
      amount: 318000,
      vatPercent: 20,
      date: "2026-03-04",
    });
  });

  it("sends an empty box as an explicit clear-out, not as an omission", async () => {
    await updateFileExtractedFields(ctx, "file-1", form({ amount: "", vatPercent: "", date: "" }));

    expect(payload().correction).toMatchObject({ amount: null, vatPercent: null, date: null });
  });

  it("omits a value it could not parse rather than clearing the stored one", async () => {
    // The old client behaviour: an unreadable amount left `extractedAmount`
    // untouched. Sending null instead would delete a good figure.
    await updateFileExtractedFields(ctx, "file-1", form({ amount: "drei tausend" }));

    expect(payload().correction).not.toHaveProperty("amount");
  });

  it("consolidates edited line items into the total the panel shows", async () => {
    await updateFileExtractedFields(
      ctx,
      "file-1",
      form({
        lineItems: [
          {
            description: "Consulting",
            quantity: "1",
            unitPrice: "2650,00",
            vatPercent: "20",
            vatAmount: "530,00",
            amount: "3180,00",
          },
        ],
      })
    );

    expect(payload().correction).toMatchObject({
      amount: 318000,
      vatAmount: 53000,
      vatPercent: 20,
      lineItems: [expect.objectContaining({ description: "Consulting", amount: 318000 })],
    });
  });

  it("clears the itemisation when the last row is removed", async () => {
    await updateFileExtractedFields(ctx, "file-1", form({ lineItems: [] }));

    expect(payload().correction).toMatchObject({ lineItems: null, vatAmount: null });
  });

  it("sends the descriptive fields separately — they are not corrections", async () => {
    await updateFileExtractedFields(
      ctx,
      "file-1",
      form({ iban: "AT611904300234573201", additionalFields: [{ label: "Nr", value: "R-1" }] })
    );

    expect(payload().details).toEqual({
      partner: "ACME GmbH",
      vatId: "ATU12345678",
      iban: "AT611904300234573201",
      address: null,
      additionalFields: [{ label: "Nr", value: "R-1", rawValue: "R-1" }],
    });
    expect(payload().correction).not.toHaveProperty("partner");
  });

  it("propagates a callable failure instead of swallowing it", async () => {
    callableInvoke.mockRejectedValueOnce(new Error("invalid-argument"));

    await expect(updateFileExtractedFields(ctx, "file-1", form())).rejects.toThrow(
      "invalid-argument"
    );
  });
});
