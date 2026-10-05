/**
 * A stored date is UTC midnight of the Vienna calendar day, and its day is the
 * UTC date part, whatever zone the host runs in.
 *
 * The Due Date and Debit Date readers, and the billing cycle's day of month,
 * used to build and read days with the local-zone constructor and getters. On
 * a UTC host the two agree, so nothing showed; east of UTC+12 a parsed Debit
 * Date landed on the day before, and west of UTC every stored Transaction date
 * read as the day before. These cases pin the host zone at both extremes.
 */

import { describe, it, expect, afterEach } from "vitest";
import { parseIsoDueDate, dueDateFromAdditionalFields } from "../dueDate";
import { debitDateFromAdditionalFields, isDebitDateHit } from "../debitDate";
import { deriveLearnedCycles } from "../billingCycle";

const HOST_ZONES = ["Pacific/Kiritimati", "America/Los_Angeles"];

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

  it("parses an ISO Due Date to UTC midnight of that day", () => {
    pin();
    expect(parseIsoDueDate("2026-01-20")?.toISOString()).toBe("2026-01-20T00:00:00.000Z");
  });

  it("still rejects a rolled-over date", () => {
    pin();
    expect(parseIsoDueDate("2026-02-31")).toBeNull();
  });

  it("accepts a Due Date on the issue day and rejects the day before", () => {
    pin();
    const issue = day("2026-01-20");
    expect(
      dueDateFromAdditionalFields([{ key: "dueDate", value: "2026-01-20" }], issue)?.toISOString()
    ).toBe("2026-01-20T00:00:00.000Z");
    expect(dueDateFromAdditionalFields([{ key: "dueDate", value: "2026-01-19" }], issue)).toBeNull();
  });

  it("reads the Debit Date as UTC midnight and rejects one before the issue day", () => {
    pin();
    const issue = day("2026-01-05");
    expect(
      debitDateFromAdditionalFields([{ key: "debitDate", value: "2026-01-20" }], issue)?.toISOString()
    ).toBe("2026-01-20T00:00:00.000Z");
    expect(debitDateFromAdditionalFields([{ key: "debitDate", value: "2026-01-04" }], issue)).toBeNull();
  });

  it("counts the Debit Date settlement lag in calendar days", () => {
    pin();
    const debit = parseIsoDueDate("2026-01-16")!;
    expect(isDebitDateHit(debit, day("2026-01-15"))).toBe(false);
    expect(isDebitDateHit(debit, day("2026-01-16"))).toBe(true);
    expect(isDebitDateHit(debit, day("2026-01-19"))).toBe(true);
    expect(isDebitDateHit(debit, day("2026-01-20"))).toBe(false);
  });

  it("learns the billing day of month from the stored calendar day", () => {
    pin();
    const months = ["01", "02", "03", "04", "05", "06"];
    const [cycle] = deriveLearnedCycles(
      months.map((m) => ({ date: day(`2026-${m}-15`), amount: -9.99 }))
    );
    expect(cycle.typicalDayOfMonth).toBe(15);
  });
});
