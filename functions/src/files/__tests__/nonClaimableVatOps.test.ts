/**
 * #203: the marker is a reason from a closed set, and setting it must not
 * touch what the document says. The rules that matter are the ones a naive
 * implementation gets wrong — an arbitrary string is not a reason, and
 * "not claimable" is not "extracted wrong".
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "SERVER_TIMESTAMP" },
}));

import {
  buildClearVatNotClaimableUpdates,
  buildMarkVatNotClaimableUpdates,
  NonClaimableVatError,
  NON_CLAIMABLE_VAT_REASONS,
  parseNonClaimableVatReason,
} from "../nonClaimableVatOps";

describe("parseNonClaimableVatReason", () => {
  it("accepts every reason in the closed set", () => {
    for (const reason of NON_CLAIMABLE_VAT_REASONS) {
      expect(parseNonClaimableVatReason(reason)).toBe(reason);
    }
    expect(NON_CLAIMABLE_VAT_REASONS).toEqual([
      "insurance-tax",
      "levy",
      "discount-to-zero",
      "private",
    ]);
  });

  it("refuses anything else by naming the set", () => {
    expect(() => parseNonClaimableVatReason("versicherungssteuer")).toThrow(
      NonClaimableVatError
    );
    expect(() => parseNonClaimableVatReason(undefined)).toThrow(/insurance-tax/);
  });
});

describe("buildMarkVatNotClaimableUpdates", () => {
  it("stores the reason, not only the fact", () => {
    // paperless-ap-1004: 11% Versicherungssteuer on a film liability policy.
    const updates = buildMarkVatNotClaimableUpdates("insurance-tax");

    expect(updates.vatNotClaimableReason).toBe("insurance-tax");
    expect(updates.vatNotClaimableNote).toBeNull();
    expect(updates.vatNotClaimableAt).toBe("SERVER_TIMESTAMP");
  });

  it("leaves every extracted field alone — the document still says what it says", () => {
    const updates = buildMarkVatNotClaimableUpdates("discount-to-zero");

    for (const key of Object.keys(updates)) {
      expect(key.startsWith("extracted")).toBe(false);
    }
    expect("lineItemsUnreconciled" in updates).toBe(false);
  });

  it("keeps a note, trimmed, and refuses an oversized one", () => {
    expect(buildMarkVatNotClaimableUpdates("levy", "  ORF-Beitrag  ").vatNotClaimableNote).toBe(
      "ORF-Beitrag"
    );
    expect(buildMarkVatNotClaimableUpdates("levy", "   ").vatNotClaimableNote).toBeNull();
    expect(() => buildMarkVatNotClaimableUpdates("levy", "x".repeat(501))).toThrow(
      NonClaimableVatError
    );
  });
});

describe("buildClearVatNotClaimableUpdates", () => {
  it("clears the marker and nothing else", () => {
    expect(buildClearVatNotClaimableUpdates()).toEqual({
      vatNotClaimableReason: null,
      vatNotClaimableNote: null,
      vatNotClaimableAt: null,
      updatedAt: "SERVER_TIMESTAMP",
    });
  });
});
