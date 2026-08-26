/**
 * Boundary math for YYYY-MM-DD date-range filters (fork #65).
 *
 * Transactions are stored as UTC midnight of the Vienna calendar day, so a
 * date window is pure-UTC string math — no host or Vienna offset may leak in.
 */

import { describe, it, expect } from "vitest";
import { dayStartUtc, dayEndExclusiveUtc } from "./dateWindow";
import { periodBoundaries } from "./rateSet";

const iso = (d: Date | null) => d?.toISOString() ?? null;

describe("dayStartUtc", () => {
  it("returns UTC midnight of the given calendar day", () => {
    expect(iso(dayStartUtc("2026-04-01"))).toBe("2026-04-01T00:00:00.000Z");
  });

  it("does not drift in summer, when Vienna is +02:00", () => {
    expect(iso(dayStartUtc("2026-07-15"))).toBe("2026-07-15T00:00:00.000Z");
  });

  it("does not drift in winter, when Vienna is +01:00", () => {
    expect(iso(dayStartUtc("2026-01-15"))).toBe("2026-01-15T00:00:00.000Z");
  });

  it("starts strictly after the previous day's stored midnight", () => {
    // The #65 bug: a +01:00 from-boundary lands at 23:00 UTC of the previous
    // day, so the last transaction of the prior period leaks into the window.
    const start = dayStartUtc("2026-04-01")!.getTime();
    expect(start).toBeGreaterThan(Date.parse("2026-03-31T00:00:00Z"));
  });

  it("rejects anything that is not a YYYY-MM-DD calendar day", () => {
    expect(dayStartUtc("")).toBeNull();
    expect(dayStartUtc("2026-4-1")).toBeNull();
    expect(dayStartUtc("01/04/2026")).toBeNull();
    expect(dayStartUtc("not-a-date")).toBeNull();
    expect(dayStartUtc("2026-04-01T00:00:00Z")).toBeNull();
  });

  it("rejects a calendar day that does not exist", () => {
    expect(dayStartUtc("2026-02-30")).toBeNull();
    expect(dayStartUtc("2026-13-01")).toBeNull();
  });
});

describe("dayEndExclusiveUtc", () => {
  it("returns UTC midnight of the following day, so the end day is inclusive", () => {
    expect(iso(dayEndExclusiveUtc("2026-06-30"))).toBe("2026-07-01T00:00:00.000Z");
  });

  it("rolls over a year end", () => {
    expect(iso(dayEndExclusiveUtc("2026-12-31"))).toBe("2027-01-01T00:00:00.000Z");
  });

  it("rolls over a leap day", () => {
    expect(iso(dayEndExclusiveUtc("2028-02-28"))).toBe("2028-02-29T00:00:00.000Z");
    expect(iso(dayEndExclusiveUtc("2028-02-29"))).toBe("2028-03-01T00:00:00.000Z");
  });

  it("does not drift across the CEST changeover", () => {
    // 2026-03-29 is the Vienna DST switch; in UTC it is an ordinary day.
    expect(iso(dayEndExclusiveUtc("2026-03-29"))).toBe("2026-03-30T00:00:00.000Z");
  });

  it("rejects the same inputs as dayStartUtc", () => {
    expect(dayEndExclusiveUtc("")).toBeNull();
    expect(dayEndExclusiveUtc("2026-2-30")).toBeNull();
    expect(dayEndExclusiveUtc("nonsense")).toBeNull();
  });
});

describe("window composed from periodBoundaries", () => {
  it("matches the window calculateUva runs on for a quarter", () => {
    const bounds = periodBoundaries({ year: 2026, period: 2, type: "quarterly" });

    expect(iso(dayStartUtc(bounds.start))).toBe("2026-04-01T00:00:00.000Z");
    expect(iso(dayEndExclusiveUtc(bounds.end))).toBe("2026-07-01T00:00:00.000Z");
  });

  it("leaves no gap or overlap between consecutive quarters", () => {
    const q1 = periodBoundaries({ year: 2026, period: 1, type: "quarterly" });
    const q2 = periodBoundaries({ year: 2026, period: 2, type: "quarterly" });

    expect(iso(dayEndExclusiveUtc(q1.end))).toBe(iso(dayStartUtc(q2.start)));
  });
});
