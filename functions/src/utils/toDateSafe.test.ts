import { describe, it, expect } from "vitest";
import { toDateSafe } from "./toDateSafe";

describe("toDateSafe (functions copy)", () => {
  const when = new Date("2026-02-01T10:00:00.000Z");

  it("reads every timestamp shape the app actually stores", () => {
    expect(toDateSafe({ toDate: () => when })).toEqual(when);
    expect(toDateSafe({ seconds: when.getTime() / 1000, nanoseconds: 0 })).toEqual(when);
    expect(toDateSafe(when)).toEqual(when);
    expect(toDateSafe(when.toISOString())).toEqual(when);
  });

  it("returns null for what used to throw, instead of throwing", () => {
    expect(toDateSafe("not a date at all")).toBeNull();
    expect(toDateSafe(1_770_000_000_000)).toBeNull();
    expect(toDateSafe({ nanoseconds: 0 })).toBeNull();
    expect(toDateSafe({})).toBeNull();
    expect(toDateSafe(null)).toBeNull();
    expect(toDateSafe(undefined)).toBeNull();
  });

  it("returns null for a malformed serialized timestamp instead of the epoch or an Invalid Date", () => {
    expect(toDateSafe({ seconds: null, nanoseconds: null })).toBeNull();
    expect(toDateSafe({ seconds: undefined })).toBeNull();
    expect(toDateSafe({ seconds: "1700000000" })).toBeNull();
  });

  it("keeps a genuine zero seconds, which is a date and not an absence", () => {
    // The tempting one-line fix for the epoch bug is `if (!ts.seconds) return null`,
    // which would also throw away 1970-01-01 itself — a real, storable instant.
    expect(toDateSafe({ seconds: 0, nanoseconds: 0 })).toEqual(new Date(0));
    // Negative seconds are pre-1970, equally real.
    expect(toDateSafe({ seconds: -86400, nanoseconds: 0 })).toEqual(new Date(-86400000));
  });

  it("returns null for seconds that are numeric but not finite", () => {
    expect(toDateSafe({ seconds: NaN })).toBeNull();
    expect(toDateSafe({ seconds: Infinity })).toBeNull();
  });

  it("still returns the correct Date, to the millisecond, for a valid pair", () => {
    expect(toDateSafe({ seconds: when.getTime() / 1000, nanoseconds: 500_000_000 })).toEqual(
      new Date(when.getTime() + 500)
    );
  });
});
