/**
 * #139 wiring: applyPartnerMatchUpdates ends with one batch re-score per
 * affected Partner — the Partners its writes assign, plus the previous
 * Partners the caller names (a reassign or clear has an old side too).
 * The re-score is derived data, so a failure there never fails the writes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { rescoreUnconnectedFilesForPartners, batchUpdate, batchCommit } = vi.hoisted(() => ({
  rescoreUnconnectedFilesForPartners: vi.fn(async () => ({
    partnersProcessed: 0,
    filesRescored: 0,
  })),
  batchUpdate: vi.fn(),
  batchCommit: vi.fn(async () => undefined),
}));

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: vi.fn(() => ({
    batch: vi.fn(() => ({ update: batchUpdate, commit: batchCommit })),
    collection: vi.fn(),
  })),
  FieldValue: {
    serverTimestamp: vi.fn(() => "SERVER_TS"),
    arrayUnion: vi.fn((...entries: unknown[]) => ({ __arrayUnion: entries })),
  },
  Timestamp: { now: vi.fn(() => "NOW") },
}));

vi.mock("../rescorePartnerFiles", () => ({ rescoreUnconnectedFilesForPartners }));

import { applyPartnerMatchUpdates } from "../partnerMatchingShared";

const op = (updates: Record<string, unknown>) => ({
  ref: { id: "tx" } as unknown as FirebaseFirestore.DocumentReference,
  updates,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("applyPartnerMatchUpdates file re-score (#139)", () => {
  it("re-scores once per affected Partner: assigned and previous", async () => {
    await applyPartnerMatchUpdates(
      [
        op({ partnerId: "p-new" }),
        op({ partnerId: "p-new" }),
        op({ partnerId: null }), // a clear names no new Partner
        op({ partnerSuggestions: [] }), // suggestion-only write, no Partner change
      ],
      { userId: "u1", extraPartnerIds: ["p-old", "p-new"] }
    );

    expect(batchCommit).toHaveBeenCalled();
    expect(rescoreUnconnectedFilesForPartners).toHaveBeenCalledTimes(1);
    const [, userId, partnerIds] = rescoreUnconnectedFilesForPartners.mock
      .calls[0] as unknown as [unknown, string, Iterable<string>];
    expect(userId).toBe("u1");
    expect([...partnerIds].sort()).toEqual(["p-new", "p-old"]);
  });

  it("does not re-score when no write touched a Partner", async () => {
    await applyPartnerMatchUpdates([op({ partnerSuggestions: [] })], { userId: "u1" });

    expect(rescoreUnconnectedFilesForPartners).not.toHaveBeenCalled();
  });

  it("does not re-score when the caller passes no context", async () => {
    await applyPartnerMatchUpdates([op({ partnerId: "p-new" })]);

    expect(rescoreUnconnectedFilesForPartners).not.toHaveBeenCalled();
  });

  it("a re-score failure never fails the applied writes", async () => {
    rescoreUnconnectedFilesForPartners.mockRejectedValueOnce(new Error("boom"));

    await expect(
      applyPartnerMatchUpdates([op({ partnerId: "p-new" })], { userId: "u1" })
    ).resolves.toBeUndefined();
    expect(batchCommit).toHaveBeenCalled();
  });
});
