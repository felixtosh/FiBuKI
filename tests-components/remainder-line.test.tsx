/**
 * #246: a File dropped on the connect overlay is connected before its
 * Extraction runs. While it is being read the Remainder line must not treat it
 * as 0,00 and report the whole Transaction as open; it says the File is still
 * being read instead.
 */

import { describe, expect, it } from "vitest";
import { pendingFilesLabel, remainderLineState } from "@/lib/matching/remainder-line";

describe("remainderLineState", () => {
  it("does not report the whole amount when the only File is still being read", () => {
    expect(remainderLineState(-10000, [{ payment: null, extractionPending: true }])).toEqual({
      kind: "pending",
      pendingCount: 1,
    });
  });

  it("excludes a File being read from the sum, and says so", () => {
    expect(
      remainderLineState(-10000, [
        { payment: 10000, extractionPending: false },
        { payment: null, extractionPending: true },
      ])
    ).toEqual({ kind: "figure", remainder: 0, pendingCount: 1 });
  });

  it("shows the sum of several finished Files against the Transaction (the split case)", () => {
    expect(
      remainderLineState(-10000, [
        { payment: 6000, extractionPending: false },
        { payment: 3000, extractionPending: false },
      ])
    ).toEqual({ kind: "figure", remainder: 1000, pendingCount: 0 });
  });

  it("stays hidden with nothing to count and nothing being read", () => {
    expect(remainderLineState(-10000, [{ payment: null, extractionPending: false }])).toEqual({
      kind: "hidden",
    });
    expect(remainderLineState(-10000, [])).toEqual({ kind: "hidden" });
  });

  it("reports missing amounts for a finished File without one", () => {
    expect(
      remainderLineState(-10000, [
        { payment: 6000, extractionPending: false },
        { payment: null, extractionPending: false },
      ])
    ).toEqual({ kind: "missing", pendingCount: 0 });
  });

  it("reports missing amounts when a currency conversion failed", () => {
    expect(
      remainderLineState(-10000, [{ payment: 6000, extractionPending: false, conversionFailed: true }])
    ).toEqual({ kind: "missing", pendingCount: 0 });
  });
});

describe("pendingFilesLabel", () => {
  it("names how many Files it could not count yet", () => {
    expect(pendingFilesLabel(1)).toBe("1 File still being read");
    expect(pendingFilesLabel(3)).toBe("3 Files still being read");
  });
});
