/**
 * Import date-format detection (fork #70).
 *
 * `us` (MM/DD/YYYY) and `eu-slash` (DD/MM/YYYY) carry identical patterns, so
 * auto-detection used to resolve the tie by array position and silently swap
 * day and month on any European column whose sampled days all sit at 12 or
 * below. For an Austrian tool that moves transactions between UVA periods.
 *
 * Covers repo-root lib/import/date-parsers.ts, so it runs under
 * vitest.api-smoke.config.ts ONLY (needs root node_modules for date-fns).
 */

import { describe, it, expect, vi } from "vitest";

// field-matcher pulls the AI matcher, which imports the browser Firebase SDK.
// The rule-based path under test never calls it.
vi.mock("firebase/functions", () => ({ httpsCallable: () => async () => ({ data: {} }) }));
vi.mock("@/lib/firebase/config", () => ({ functions: {}, db: {}, auth: {} }));

import {
  detectDateFormat,
  analyzeDayMonthOrder,
  findDateColumnConflict,
  looksLikeDateColumn,
  dayMonthOrderOfFormat,
  parseDate,
  DATE_PARSERS,
} from "@/lib/import/date-parsers";
import { autoMatchColumnsRuleBased } from "@/lib/import/field-matcher";

describe("analyzeDayMonthOrder", () => {
  it("proves day-first when a first component exceeds 12", () => {
    expect(analyzeDayMonthOrder(["03/07/2026", "31/07/2026"])).toBe("day-first");
  });

  it("proves month-first when a second component exceeds 12", () => {
    expect(analyzeDayMonthOrder(["07/03/2026", "07/31/2026"])).toBe("month-first");
  });

  it("reports no evidence when every component could be either", () => {
    expect(analyzeDayMonthOrder(["03/07/2026", "05/06/2026", "01/02/2026"])).toBe("none");
  });

  it("reports a conflict when the column proves both", () => {
    expect(analyzeDayMonthOrder(["31/07/2026", "07/31/2026"])).toBe("conflict");
  });

  it("reads dots and dashes, not just slashes", () => {
    expect(analyzeDayMonthOrder(["31.07.2026"])).toBe("day-first");
    expect(analyzeDayMonthOrder(["07-31-2026"])).toBe("month-first");
  });

  it("ignores values that carry no day/month ambiguity", () => {
    expect(analyzeDayMonthOrder(["2026-07-31", "31 July 2026", "31-Jul-2026", ""])).toBe("none");
  });

  it("ignores a value that is no date in either order", () => {
    // 13/13/2026 would otherwise prove both orders at once and forge a
    // conflict out of one garbage row.
    expect(analyzeDayMonthOrder(["03/07/2026", "13/13/2026", "31/07/2026"])).toBe("day-first");
    expect(analyzeDayMonthOrder(["13/13/2026"])).toBe("none");
  });

  it("reads the whole column, not a leading slice", () => {
    const column = [...Array(200).fill("03/07/2026"), "31/07/2026"];

    expect(analyzeDayMonthOrder(column)).toBe("day-first");
  });
});

describe("detectDateFormat", () => {
  it("picks the European parser when the column proves day-first", () => {
    const samples = ["03/07/2026", "15/07/2026", "31/07/2026", "01/08/2026"];

    expect(detectDateFormat(samples)).toBe("eu-slash");
  });

  it("picks the US parser when the column proves month-first", () => {
    const samples = ["07/03/2026", "07/15/2026", "07/31/2026", "08/01/2026"];

    expect(detectDateFormat(samples)).toBe("us");
  });

  it("refuses to guess when the column proves neither", () => {
    // The silent-swap case: every day is 12 or lower, so both parsers score
    // identically. Guessing here is what wrote 3 July in as 7 March.
    const samples = ["03/07/2026", "05/06/2026", "01/02/2026", "11/12/2026"];

    expect(detectDateFormat(samples)).toBeNull();
  });

  it("refuses to guess when the column proves both", () => {
    expect(detectDateFormat(["31/07/2026", "07/31/2026", "01/02/2026"])).toBeNull();
  });

  it("still detects the unambiguous formats", () => {
    expect(detectDateFormat(["2026-07-31", "2026-08-01"])).toBe("iso");
    expect(detectDateFormat(["2026-07-31 10:15:00"])).toBe("iso-datetime");
    expect(detectDateFormat(["2026-07-31T10:15:00"])).toBe("iso-datetime-t");
    expect(detectDateFormat(["31.07.2026", "01.08.2026"])).toBe("de");
    expect(detectDateFormat(["31-Jul-2026"])).toBe("text-short");
    expect(detectDateFormat(["31 July 2026"])).toBe("text-long");
  });

  it("keeps requiring half the column to parse", () => {
    expect(detectDateFormat(["not a date", "also not", "31/07/2026"])).toBeNull();
  });

  it("returns null for an empty column", () => {
    expect(detectDateFormat([])).toBeNull();
    expect(detectDateFormat(["", "  "])).toBeNull();
  });

  it("overrules a single leader the column contradicts", () => {
    // Two-digit years: before eu-slash-short shipped, us-short was the only
    // parser matching this shape, so it won unopposed and swapped every row.
    const samples = ["15/03/26", "03/07/26", "05/06/26", "09/08/26"];

    expect(analyzeDayMonthOrder(samples)).toBe("day-first");
    expect(detectDateFormat(samples)).toBe("eu-slash-short");
  });

  it("refuses a contradicted leader that has no counterpart", () => {
    // Dotted month-first (MM.DD.YYYY) is not a format that ships, so there is
    // nothing to fall back to — naming "de" here would swap every readable row.
    const samples = ["07.31.2026", "07.03.2026"];

    expect(detectDateFormat(samples)).toBeNull();
  });

  it("keeps a lone ambiguous leader the column says nothing about", () => {
    // Only "de" matches this shape, and nothing contradicts it.
    expect(detectDateFormat(["03.07.2026", "05.06.2026"])).toBe("de");
  });

  it("refuses a short slash column that proves nothing", () => {
    expect(detectDateFormat(["03/07/26", "05/06/26"])).toBeNull();
  });

  it("resolves the tie the same way whatever the row order", () => {
    const proving = ["31/07/2026", "03/07/2026", "05/06/2026"];

    expect(detectDateFormat(proving)).toBe("eu-slash");
    expect(detectDateFormat([...proving].reverse())).toBe("eu-slash");
  });
});

describe("looksLikeDateColumn", () => {
  it("recognises a date column whose day/month order is unresolved", () => {
    // detectDateFormat refuses to name a parser here, but the column is still
    // a date column — it must not fall through to amount or no-match.
    const samples = ["03/07/2026", "05/06/2026", "01/02/2026"];

    expect(detectDateFormat(samples)).toBeNull();
    expect(looksLikeDateColumn(samples)).toBe(true);
  });

  it("recognises the unambiguous formats", () => {
    expect(looksLikeDateColumn(["2026-07-31"])).toBe(true);
    expect(looksLikeDateColumn(["31.07.2026", "01.08.2026"])).toBe(true);
  });

  it("rejects columns that are not dates", () => {
    expect(looksLikeDateColumn(["Amazon", "Netflix"])).toBe(false);
    expect(looksLikeDateColumn(["-25.00", "1200.50"])).toBe(false);
    expect(looksLikeDateColumn([])).toBe(false);
  });
});

describe("dayMonthOrderOfFormat", () => {
  it("reads the order of a numeric day/month format", () => {
    expect(dayMonthOrderOfFormat("dd/MM/yyyy")).toBe("day-first");
    expect(dayMonthOrderOfFormat("MM/dd/yyyy")).toBe("month-first");
    expect(dayMonthOrderOfFormat("dd.MM.yyyy")).toBe("day-first");
    expect(dayMonthOrderOfFormat("dd-MM-yyyy")).toBe("day-first");
    expect(dayMonthOrderOfFormat("MM/dd/yy")).toBe("month-first");
  });

  it("returns null for formats that cannot swap day and month", () => {
    // Year-first: "yyyy-MM-dd" holds both tokens but in no ambiguous position.
    expect(dayMonthOrderOfFormat("yyyy-MM-dd")).toBeNull();
    expect(dayMonthOrderOfFormat("yyyy-MM-dd HH:mm:ss")).toBeNull();
    expect(dayMonthOrderOfFormat("yyyy-MM-dd'T'HH:mm:ss")).toBeNull();
    // Spelled-out months name themselves.
    expect(dayMonthOrderOfFormat("dd-MMM-yyyy")).toBeNull();
    expect(dayMonthOrderOfFormat("dd MMMM yyyy")).toBeNull();
  });

  it("covers every parser that ships", () => {
    const ambiguous = DATE_PARSERS.filter((p) => dayMonthOrderOfFormat(p.format) !== null);

    expect(ambiguous.map((p) => p.id).sort()).toEqual([
      "dash-dmy",
      "de",
      "de-short",
      "eu-slash",
      "eu-slash-short",
      "us",
      "us-short",
    ]);
  });

  it("gives every two-digit-year slash order a parser to swap to", () => {
    // DD/MM/YY had no counterpart, so a proven day-first short column had
    // nothing to resolve to and no format for the user to pick.
    expect(DATE_PARSERS.find((p) => p.id === "eu-slash-short")?.format).toBe("dd/MM/yy");
    expect(DATE_PARSERS.find((p) => p.id === "us-short")?.format).toBe("MM/dd/yy");
  });
});

describe("findDateColumnConflict", () => {
  it("flags a month-first parser on a column that proves day-first", () => {
    const conflict = findDateColumnConflict(["03/07/2026", "31/07/2026"], "us");

    expect(conflict).not.toBeNull();
    expect(conflict?.evidence).toBe("day-first");
    expect(conflict?.suggestedParserId).toBe("eu-slash");
  });

  it("flags a day-first parser on a column that proves month-first", () => {
    const conflict = findDateColumnConflict(["07/31/2026"], "eu-slash");

    expect(conflict?.evidence).toBe("month-first");
    expect(conflict?.suggestedParserId).toBe("us");
  });

  it("flags a column that proves both, with no parser to suggest", () => {
    const conflict = findDateColumnConflict(["31/07/2026", "07/31/2026"], "eu-slash");

    expect(conflict?.evidence).toBe("conflict");
    expect(conflict?.suggestedParserId).toBeNull();
  });

  it("passes a parser that agrees with the evidence", () => {
    expect(findDateColumnConflict(["03/07/2026", "31/07/2026"], "eu-slash")).toBeNull();
    expect(findDateColumnConflict(["07/31/2026"], "us")).toBeNull();
  });

  it("passes a column with no evidence — an explicit choice is respected", () => {
    expect(findDateColumnConflict(["03/07/2026", "05/06/2026"], "us")).toBeNull();
  });

  it("passes formats that cannot swap day and month", () => {
    expect(findDateColumnConflict(["2026-07-31"], "iso")).toBeNull();
    expect(findDateColumnConflict(["2026-07-31 10:15:00"], "iso-datetime")).toBeNull();
    expect(findDateColumnConflict(["31-Jul-2026"], "text-short")).toBeNull();
  });

  it("flags a month-first column against the German default, with nothing to suggest", () => {
    // "de" is the fallback format, and no MM.DD.YYYY parser ships, so the
    // caller has to describe the mismatch rather than name a replacement.
    const conflict = findDateColumnConflict(["07.31.2026", "07.03.2026"], "de");

    expect(conflict?.evidence).toBe("month-first");
    expect(conflict?.expected).toBe("day-first");
    expect(conflict?.suggestedParserId).toBeNull();
  });

  it("names a value that contradicts the chosen order", () => {
    const dayFirstParser = findDateColumnConflict(["03/07/2026", "07/31/2026"], "eu-slash");
    expect(dayFirstParser?.offendingValue).toBe("07/31/2026");

    const monthFirstParser = findDateColumnConflict(["07/03/2026", "31/07/2026"], "us");
    expect(monthFirstParser?.offendingValue).toBe("31/07/2026");
  });

  it("names the contradicting value when the column proves both", () => {
    const conflict = findDateColumnConflict(["31/07/2026", "07/31/2026"], "eu-slash");

    expect(conflict?.evidence).toBe("conflict");
    expect(conflict?.offendingValue).toBe("07/31/2026");
  });

  it("passes an unknown parser id rather than throwing", () => {
    expect(findDateColumnConflict(["03/07/2026"], "no-such-parser")).toBeNull();
  });
});

describe("parseDate still reads what detection selected", () => {
  it("reads a proven European column as day-first", () => {
    const parsed = parseDate("03/07/2026", "eu-slash");

    expect(parsed?.toISOString()).toBe("2026-07-03T00:00:00.000Z");
  });

  it("reads a proven US column as month-first", () => {
    const parsed = parseDate("07/03/2026", "us");

    expect(parsed?.toISOString()).toBe("2026-07-03T00:00:00.000Z");
  });
});

describe("rule-based column matching (#70 end to end)", () => {
  const rows = (dates: string[]) =>
    dates.map((date, i) => ({ Buchungstag: date, Betrag: `-${10 + i},00`, Name: "Partner" }));

  it("suggests the European parser when the column proves day-first", async () => {
    const mappings = await autoMatchColumnsRuleBased(
      ["Buchungstag", "Betrag", "Name"],
      rows(["03/07/2026", "05/06/2026", "31/07/2026"])
    );
    const date = mappings.find((m) => m.csvColumn === "Buchungstag");

    expect(date?.targetField).toBe("date");
    expect(date?.format).toBe("eu-slash");
  });

  it("keeps the column as a date but leaves the format unset when unproven", async () => {
    const mappings = await autoMatchColumnsRuleBased(
      ["Buchungstag", "Betrag", "Name"],
      rows(["03/07/2026", "05/06/2026", "01/02/2026"])
    );
    const date = mappings.find((m) => m.csvColumn === "Buchungstag");

    expect(date?.targetField).toBe("date");
    expect(date?.format).toBeUndefined();
  });

  it("reads past the 10-value sample to find the proving row", async () => {
    const dates = [...Array(20).fill("03/07/2026"), "31/07/2026"];

    const mappings = await autoMatchColumnsRuleBased(
      ["Buchungstag", "Betrag", "Name"],
      rows(dates)
    );

    expect(mappings.find((m) => m.csvColumn === "Buchungstag")?.format).toBe("eu-slash");
  });
});

/**
 * A date column that carries a time, and one that writes single-digit day and
 * month components.
 *
 * Every pattern in the table demanded exactly two digits per component and no
 * slash format carried a time at all, so a Revolut export ("2/1/26 3:18") hit
 * zero parsers: every row of the import preview read "Invalid" with nothing
 * naming the cause. date-fns rejects trailing text it was not told to expect,
 * so the time had to be read off before the date could be parsed at all.
 */
describe("dates that carry a time", () => {
  // One Revolut "Completed Date" column, verbatim.
  const revolut = [
    "2/1/26 3:18",
    "1/25/26 6:12",
    "9/2/26 10:02",
    "2/14/26 6:40",
    "2/14/26 6:41",
    "2/4/26 6:13",
    "7/5/26 5:58",
    "5/13/26 3:13",
    "5/14/26 11:31",
    "5/16/26 10:10",
    "5/25/26 5:53",
    "5/27/26 2:54",
    "3/8/26 6:11",
    "4/1/26 5:48",
    "4/19/26 5:32",
    "4/20/26 5:45",
    "4/20/26 5:45",
    "5/15/26 11:39",
  ];

  it("parses a slash date with a trailing time", () => {
    expect(parseDate("2/1/26 3:18", "us-short")?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(parseDate("31/07/2026 10:15:00", "eu-slash")?.toISOString()).toBe(
      "2026-07-31T00:00:00.000Z"
    );
  });

  it("parses a 12-hour time with a meridiem", () => {
    expect(parseDate("31/07/2026 11:30 PM", "eu-slash")?.toISOString()).toBe(
      "2026-07-31T00:00:00.000Z"
    );
  });

  it("parses single-digit day and month components", () => {
    expect(parseDate("1/2/2026", "eu-slash")?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(parseDate("1.2.2026", "de")?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(parseDate("1-Jul-2026", "text-short")?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(parseDate("1 July 2026", "text-long")?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("detects a column written with single-digit components", () => {
    // The patterns demanded exactly two digits, so a column that drops the
    // leading zero scored below the 50% threshold and detection gave up on a
    // column it can read perfectly well.
    expect(looksLikeDateColumn(["1/2/2026", "3/4/2026"])).toBe(true);
    expect(detectDateFormat(["1/2/2026", "3/4/2026", "31/7/2026"])).toBe("eu-slash");
    expect(detectDateFormat(["1/2/2026", "3/4/2026", "7/31/2026"])).toBe("us");
    expect(detectDateFormat(["1.2.2026", "31.7.2026"])).toBe("de");
  });

  it("reads the day/month evidence past the time", () => {
    // Anchored on the end of the value, the evidence regex saw no date at all
    // in a timestamped column and reported "none" — which is exactly the state
    // that lets detection fall back to array position and swap day and month.
    expect(analyzeDayMonthOrder(["07/31/2026 10:15"])).toBe("month-first");
    expect(analyzeDayMonthOrder(["31/07/2026 10:15"])).toBe("day-first");
    expect(analyzeDayMonthOrder(revolut)).toBe("month-first");
  });

  it("still flags a day/month conflict on a timestamped column", () => {
    const conflict = findDateColumnConflict(["03/07/2026 10:15", "07/31/2026 10:15"], "eu-slash");

    expect(conflict?.evidence).toBe("month-first");
    expect(conflict?.suggestedParserId).toBe("us");
    expect(conflict?.offendingValue).toBe("07/31/2026");
  });

  it("detects the format of a whole Revolut column", () => {
    expect(looksLikeDateColumn(revolut)).toBe(true);
    expect(detectDateFormat(revolut)).toBe("us-short");
  });

  it("parses every row of that column, none Invalid", () => {
    const parsed = revolut.map((value) => parseDate(value, "us-short"));

    expect(parsed.filter((d) => d === null)).toEqual([]);
    expect(parsed[0]?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(parsed[7]?.toISOString()).toBe("2026-05-13T00:00:00.000Z");
  });

  it("leaves the ISO datetime parsers owning their own shapes", () => {
    // Reading a time off makes "2026-07-31 10:15:00" match `iso` as well, and
    // a tie is resolved by table order — the more specific parser comes first.
    expect(detectDateFormat(["2026-07-31 10:15:00"])).toBe("iso-datetime");
    expect(detectDateFormat(["2026-07-31T10:15:00"])).toBe("iso-datetime-t");
    expect(parseDate("2026-07-31 10:15:00", "iso-datetime")?.toISOString()).toBe(
      "2026-07-31T00:00:00.000Z"
    );
  });

  it("does not mistake a bare time or a number for a date", () => {
    expect(looksLikeDateColumn(["10:15", "11:30"])).toBe(false);
    expect(parseDate("10:15", "us-short")).toBeNull();
  });
});
