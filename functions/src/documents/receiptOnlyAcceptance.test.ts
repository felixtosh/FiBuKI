/**
 * Accepted Receipt (#165) - liveness of the recorded ruling.
 *
 * The ruling never deletes itself; it goes STALE, derived on read. These
 * tests pin the derivation: live exactly while the transaction is still
 * receipt-only over the same set of files the ruling was made over.
 */

import { describe, it, expect } from "vitest";
import { isAcceptanceLive } from "./receiptOnlyAcceptance";

const acceptance = (fileIds: string[]) => ({
  by: "user-1",
  at: new Date("2026-09-27T10:00:00Z"),
  reason: "Marketplace seller charges no VAT; no § 11 invoice obtainable",
  fileIds,
});

describe("isAcceptanceLive", () => {
  it("is live while the state is receipt-only over the same files", () => {
    expect(
      isAcceptanceLive({
        fileIds: ["f-1"],
        documentationState: "receipt-only",
        receiptOnlyAcceptance: acceptance(["f-1"]),
      })
    ).toBe(true);
  });

  it("compares the files as a set, not as an ordered list", () => {
    expect(
      isAcceptanceLive({
        fileIds: ["f-2", "f-1"],
        documentationState: "receipt-only",
        receiptOnlyAcceptance: acceptance(["f-1", "f-2"]),
      })
    ).toBe(true);
  });

  it("goes stale when a file was added after the ruling", () => {
    expect(
      isAcceptanceLive({
        fileIds: ["f-1", "f-2"],
        documentationState: "receipt-only",
        receiptOnlyAcceptance: acceptance(["f-1"]),
      })
    ).toBe(false);
  });

  it("goes stale when a file was removed after the ruling", () => {
    expect(
      isAcceptanceLive({
        fileIds: [],
        documentationState: "receipt-only",
        receiptOnlyAcceptance: acceptance(["f-1"]),
      })
    ).toBe(false);
  });

  it("goes stale when the documentation state moved off receipt-only", () => {
    // The invoice finally arrived: the ruling has nothing left to close.
    expect(
      isAcceptanceLive({
        fileIds: ["f-1"],
        documentationState: "invoice",
        receiptOnlyAcceptance: acceptance(["f-1"]),
      })
    ).toBe(false);
  });

  it("is never live without a recorded ruling", () => {
    expect(
      isAcceptanceLive({ fileIds: ["f-1"], documentationState: "receipt-only" })
    ).toBe(false);
    expect(
      isAcceptanceLive({
        fileIds: ["f-1"],
        documentationState: "receipt-only",
        receiptOnlyAcceptance: null,
      })
    ).toBe(false);
  });
});
