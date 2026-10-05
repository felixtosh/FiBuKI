/**
 * A stored date is UTC midnight of the Vienna calendar day (#673). These
 * cases pin the host zone at both extremes and in Vienna itself, whose clock
 * changes are what moved a due date by a day.
 */

import { describe, it, expect, afterEach } from "vitest";
import { dayOf, yearOf, addDays, viennaToday, viennaYear } from "./storedDay";

const HOST_ZONES = ["UTC", "Europe/Vienna", "America/Los_Angeles", "Pacific/Kiritimati"];

/** UTC midnight of an ISO day, the way a stored date is written. */
function day(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

const originalZone = process.env.TZ;

afterEach(() => {
  // Node re-reads TZ when it is assigned.
  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;
});

describe.each(HOST_ZONES)("on a host in %s", (zone) => {
  const pin = () => {
    process.env.TZ = zone;
  };

  it("names the day a stored date was written for", () => {
    pin();
    expect(dayOf(day("2027-01-01"))).toBe("2027-01-01");
    expect(dayOf(day("2026-12-31"))).toBe("2026-12-31");
    expect(dayOf(day("2028-02-29"))).toBe("2028-02-29");
  });

  it("reads the year of a stored New Year's Day and New Year's Eve", () => {
    pin();
    expect(yearOf(day("2027-01-01"))).toBe(2027);
    expect(yearOf(day("2026-12-31"))).toBe(2026);
  });

  it("adds days across both clock changes without leaving UTC midnight", () => {
    pin();
    const spring = addDays(day("2026-03-15"), 30);
    expect(spring.toISOString()).toBe("2026-04-14T00:00:00.000Z");
    const autumn = addDays(day("2026-10-15"), 14);
    expect(autumn.toISOString()).toBe("2026-10-29T00:00:00.000Z");
  });

  it("adds days over a leap day and a year end, and subtracts them", () => {
    pin();
    expect(dayOf(addDays(day("2028-02-28"), 1))).toBe("2028-02-29");
    expect(dayOf(addDays(day("2026-12-31"), 1))).toBe("2027-01-01");
    expect(dayOf(addDays(day("2026-03-01"), -1))).toBe("2026-02-28");
  });

  it("takes a date with a time of day to the stored day it falls on", () => {
    pin();
    expect(addDays(new Date("2026-06-10T17:45:00Z"), 0).toISOString()).toBe("2026-06-10T00:00:00.000Z");
  });

  it("is already the new year in Vienna an hour before UTC midnight on New Year's Eve", () => {
    pin();
    const now = new Date("2026-12-31T23:30:00Z");
    expect(viennaToday(now).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(viennaYear(now)).toBe(2027);
  });

  it("takes the Vienna day in summer time, two hours ahead of UTC", () => {
    pin();
    expect(viennaToday(new Date("2026-07-14T22:30:00Z")).toISOString()).toBe("2026-07-15T00:00:00.000Z");
    expect(viennaToday(new Date("2026-07-14T21:30:00Z")).toISOString()).toBe("2026-07-14T00:00:00.000Z");
  });
});
