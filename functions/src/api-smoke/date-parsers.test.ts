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
import { detectCSVFormat, parseCSV } from "@/lib/import/csv-parser";
import { DATE_FORMATS } from "../import/matchColumns";

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

  it("resolves a contradicted leader to its counterpart", () => {
    // This used to return null: dotted month-first was not a format that
    // shipped, so a column the evidence proved month-first had nothing to fall
    // back to and could not be imported at all (#303).
    const samples = ["07.31.2026", "07.03.2026"];

    expect(detectDateFormat(samples)).toBe("de-mdy");
  });

  it("refuses a dotted column that proves nothing, as it refuses a slash one", () => {
    // Every ambiguous numeric format now has a month-first sibling sharing its
    // pattern, so an ambiguous column is always a tie and detection asks the
    // user. The two "leader with no counterpart" arms of detectDateFormat are
    // unreachable from the shipped table and stay only as guards.
    expect(detectDateFormat(["03.07.2026", "05.06.2026"])).toBe(
      detectDateFormat(["03/07/2026", "05/06/2026"])
    );
    expect(detectDateFormat(["03.07.2026", "05.06.2026"])).toBeNull();
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
      "dash-dmy-short",
      "dash-mdy",
      "dash-mdy-short",
      "de",
      "de-mdy",
      "de-mdy-short",
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

  it("flags a month-first column against the German default and names the swap", () => {
    // "de" is the fallback format when the user has chosen none, so this is
    // where a month-first dotted column lands. It used to have no replacement
    // to name — the guard could only refuse the import (#303).
    const conflict = findDateColumnConflict(["07.31.2026", "07.03.2026"], "de");

    expect(conflict?.evidence).toBe("month-first");
    expect(conflict?.expected).toBe("day-first");
    expect(conflict?.suggestedParserId).toBe("de-mdy");
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

/**
 * A dashed date column that is not day-first with a four-digit year (#167).
 *
 * The table carried exactly one dashed row, `dash-dmy`, so a bank export
 * written "01-15-26" matched no format at all: the column-evidence guard
 * proved the column month-first and then had nothing to offer, and the whole
 * Source could not be imported. The dashed rows now cover the same matrix the
 * slash rows already did.
 */
describe("dashed dates that are not DD-MM-YYYY", () => {
  const iso = (value: string, parserId: string) => parseDate(value, parserId)?.toISOString();

  it("reads all four dashed shapes as 15 January 2026", () => {
    expect(iso("15-01-2026", "dash-dmy")).toBe("2026-01-15T00:00:00.000Z");
    expect(iso("01-15-2026", "dash-mdy")).toBe("2026-01-15T00:00:00.000Z");
    expect(iso("15-01-26", "dash-dmy-short")).toBe("2026-01-15T00:00:00.000Z");
    expect(iso("01-15-26", "dash-mdy-short")).toBe("2026-01-15T00:00:00.000Z");
  });

  it("detects a month-first dashed column instead of failing the import", () => {
    // The ticket's column, verbatim: no format matched it before.
    const samples = ["01-15-26", "02-03-26", "03-28-26", "12-01-26"];

    expect(analyzeDayMonthOrder(samples)).toBe("month-first");
    expect(looksLikeDateColumn(samples)).toBe(true);
    expect(detectDateFormat(samples)).toBe("dash-mdy-short");
    expect(detectDateFormat(["01-15-2026", "02-03-2026", "03-28-2026"])).toBe("dash-mdy");
  });

  it("still detects a proven day-first dashed column", () => {
    expect(detectDateFormat(["15-01-2026", "03-02-2026", "28-03-2026"])).toBe("dash-dmy");
    expect(detectDateFormat(["15-01-26", "03-02-26", "28-03-26"])).toBe("dash-dmy-short");
  });

  it("gives the guard a dashed format to point at", () => {
    // Previously "puts the month first, which none of the available date
    // formats matches" — a refusal with no way forward.
    const fourDigit = findDateColumnConflict(["01-03-2026", "01-15-2026"], "dash-dmy");
    expect(fourDigit?.evidence).toBe("month-first");
    expect(fourDigit?.suggestedParserId).toBe("dash-mdy");
    expect(fourDigit?.offendingValue).toBe("01-15-2026");

    const twoDigit = findDateColumnConflict(["01-15-26"], "dash-dmy-short");
    expect(twoDigit?.suggestedParserId).toBe("dash-mdy-short");

    // And the other way round, as `us` and `eu-slash` already do.
    expect(findDateColumnConflict(["15-01-2026"], "dash-mdy")?.suggestedParserId).toBe("dash-dmy");
  });

  it("leaves an ambiguous dashed column unresolved, as the slash column is", () => {
    const dashed = ["03-07-2026", "05-06-2026", "01-02-2026"];
    const slashed = ["03/07/2026", "05/06/2026", "01/02/2026"];

    // A dashed column with no day above 12 used to name dash-dmy unopposed,
    // which is the silent swap #70 removed from the slash formats.
    expect(detectDateFormat(dashed)).toBe(detectDateFormat(slashed));
    expect(detectDateFormat(dashed)).toBeNull();
    expect(looksLikeDateColumn(dashed)).toBe(true);
    expect(detectDateFormat(["03-07-26", "05-06-26"])).toBeNull();
  });

  it("maps two-digit years to the same century as the slash formats", () => {
    // date-fns reads "yy" into a 100-year window ending 50 years after the
    // reference date, so the century flips at (this year + 50) % 100 and not
    // at a fixed number. Pin the flip itself, and pin that dashed and slash
    // sit on the same side of it — a file read as 2026 by one format and 1926
    // by the other is a whole import filed under the wrong years.
    const flip = (new Date().getFullYear() + 50) % 100;
    const twoDigit = (yy: number) => String(yy).padStart(2, "0");
    const below = twoDigit((flip + 99) % 100);
    const at = twoDigit(flip);
    const yearOf = (value: string, parserId: string) =>
      parseDate(value, parserId)?.getUTCFullYear() ?? null;

    expect(yearOf("15-01-26", "dash-dmy-short")).toBe(2026);
    expect(yearOf("01-15-26", "dash-mdy-short")).toBe(2026);

    // One below the flip is still this century.
    expect(yearOf(`01-02-${below}`, "dash-dmy-short")).toBe(
      yearOf(`01/02/${below}`, "eu-slash-short")
    );
    expect(yearOf(`01-02-${below}`, "dash-dmy-short")).toBeGreaterThan(2050);

    // At the flip both roll back a century, which the 1990 floor then refuses.
    expect(yearOf(`01-02-${at}`, "dash-dmy-short")).toBe(yearOf(`01/02/${at}`, "eu-slash-short"));
    expect(yearOf(`01-02-${at}`, "dash-dmy-short")).toBeNull();

    // Same for the month-first pair.
    expect(yearOf(`02-01-${below}`, "dash-mdy-short")).toBe(yearOf(`02/01/${below}`, "us-short"));
    expect(yearOf(`02-01-${at}`, "dash-mdy-short")).toBe(yearOf(`02/01/${at}`, "us-short"));
  });

  it("is reachable by the AI column matcher, not only by the dropdown", () => {
    // The callable coerces a suggestion it does not recognise to "de", so a
    // format missing from this list is one auto-detection can never name — the
    // dashed rows would be dropdown-only. The list is hand-duplicated across
    // the rootDir boundary, so pin it to the table in both directions.
    expect([...DATE_FORMATS].sort()).toEqual(DATE_PARSERS.map((p) => p.id).sort());
  });

  it("carries a time, as the slash formats do", () => {
    expect(iso("01-15-26 3:18", "dash-mdy-short")).toBe("2026-01-15T00:00:00.000Z");
    expect(analyzeDayMonthOrder(["01-15-26 3:18"])).toBe("month-first");
  });

  it("imports a month-first dashed CSV end to end", async () => {
    const csv = [
      "Buchungstag;Betrag;Name",
      "01-15-26;-25,00;REWE",
      "02-03-26;-12,50;Billa",
      "03-28-26;1.200,00;Honorar",
      "12-01-26;-49,90;A1 Telekom",
    ].join("\n");

    const { headers, rows } = parseCSV(csv, detectCSVFormat(csv));
    const mappings = await autoMatchColumnsRuleBased(headers, rows);
    const date = mappings.find((m) => m.csvColumn === "Buchungstag");

    expect(date?.targetField).toBe("date");
    expect(date?.format).toBe("dash-mdy-short");

    // What the import does before writing: refuse on a day/month conflict,
    // then parse every row with the chosen format.
    const column = rows.map((row) => row.Buchungstag);
    expect(findDateColumnConflict(column, date!.format!)).toBeNull();

    const dates = column.map((value) => parseDate(value, date!.format!));

    expect(dates.map((d) => d?.toISOString().split("T")[0])).toEqual([
      "2026-01-15",
      "2026-02-03",
      "2026-03-28",
      "2026-12-01",
    ]);
  });
});

/**
 * A dotted date column that is not day-first (#303).
 *
 * `de` (DD.MM.YYYY) and `de-short` had no month-first sibling, so a dotted
 * column written "01.15.2026" matched no format at all — the same dead end
 * #167 removed for dashes. It matters more here than there: `de` is the format
 * a column falls back to when the user has chosen none, so a month-first
 * dotted column did not merely fail to auto-detect, it read day-first wherever
 * the guard did not intervene.
 */
describe("dotted dates that are not DD.MM.YYYY", () => {
  const iso = (value: string, parserId: string) => parseDate(value, parserId)?.toISOString();

  it("reads all four dotted shapes as 15 January 2026", () => {
    expect(iso("15.01.2026", "de")).toBe("2026-01-15T00:00:00.000Z");
    expect(iso("01.15.2026", "de-mdy")).toBe("2026-01-15T00:00:00.000Z");
    expect(iso("15.01.26", "de-short")).toBe("2026-01-15T00:00:00.000Z");
    expect(iso("01.15.26", "de-mdy-short")).toBe("2026-01-15T00:00:00.000Z");
  });

  it("detects a month-first dotted column instead of failing the import", () => {
    // The ticket's column, verbatim: no format matched it before.
    const samples = ["01.15.2026", "03.28.2026", "02.03.2026", "12.01.2026"];

    expect(analyzeDayMonthOrder(samples)).toBe("month-first");
    expect(looksLikeDateColumn(samples)).toBe(true);
    expect(detectDateFormat(samples)).toBe("de-mdy");
    expect(detectDateFormat(["01.15.26", "03.28.26", "02.03.26"])).toBe("de-mdy-short");
  });

  it("still detects a proven day-first dotted column", () => {
    expect(detectDateFormat(["15.01.2026", "03.02.2026", "28.03.2026"])).toBe("de");
    expect(detectDateFormat(["15.01.26", "03.02.26", "28.03.26"])).toBe("de-short");
  });

  it("gives the guard a dotted format to point at", () => {
    const fourDigit = findDateColumnConflict(["01.03.2026", "01.15.2026"], "de");
    expect(fourDigit?.evidence).toBe("month-first");
    expect(fourDigit?.suggestedParserId).toBe("de-mdy");
    expect(fourDigit?.offendingValue).toBe("01.15.2026");

    const twoDigit = findDateColumnConflict(["01.15.26"], "de-short");
    expect(twoDigit?.suggestedParserId).toBe("de-mdy-short");

    // And the other way round, as `us` and `eu-slash` already do.
    expect(findDateColumnConflict(["15.01.2026"], "de-mdy")?.suggestedParserId).toBe("de");
  });

  it("leaves an ambiguous dotted column unresolved, as the slash column is", () => {
    const dotted = ["03.07.2026", "05.06.2026", "01.02.2026"];
    const slashed = ["03/07/2026", "05/06/2026", "01/02/2026"];

    // A dotted column with no day above 12 used to name `de` unopposed, which
    // is the silent swap #70 removed from the slash formats. Asserted against
    // the slash column rather than against null, so the two rows cannot drift.
    expect(detectDateFormat(dotted)).toBe(detectDateFormat(slashed));
    expect(detectDateFormat(dotted)).toBeNull();
    expect(looksLikeDateColumn(dotted)).toBe(true);
    expect(detectDateFormat(["03.07.26", "05.06.26"])).toBe(
      detectDateFormat(["03/07/26", "05/06/26"])
    );
  });

  it("maps two-digit years to the same century as the slash formats", () => {
    // date-fns reads "yy" into a 100-year window ending 50 years after the
    // reference date, so the century flips at (this year + 50) % 100 and not at
    // a fixed number. Pin the flip itself, and pin that dotted and slash sit on
    // the same side of it — a file read as 2026 by one format and 1926 by the
    // other is a whole import filed under the wrong years.
    const flip = (new Date().getFullYear() + 50) % 100;
    const twoDigit = (yy: number) => String(yy).padStart(2, "0");
    const below = twoDigit((flip + 99) % 100);
    const at = twoDigit(flip);
    const yearOf = (value: string, parserId: string) =>
      parseDate(value, parserId)?.getUTCFullYear() ?? null;

    expect(yearOf("15.01.26", "de-short")).toBe(2026);
    expect(yearOf("01.15.26", "de-mdy-short")).toBe(2026);

    // One below the flip is still this century.
    expect(yearOf(`01.02.${below}`, "de-short")).toBe(yearOf(`01/02/${below}`, "eu-slash-short"));
    expect(yearOf(`01.02.${below}`, "de-short")).toBeGreaterThan(2050);

    // At the flip both roll back a century, which the 1990 floor then refuses.
    expect(yearOf(`01.02.${at}`, "de-short")).toBe(yearOf(`01/02/${at}`, "eu-slash-short"));
    expect(yearOf(`01.02.${at}`, "de-short")).toBeNull();

    // Same for the month-first pair.
    expect(yearOf(`02.01.${below}`, "de-mdy-short")).toBe(yearOf(`02/01/${below}`, "us-short"));
    expect(yearOf(`02.01.${at}`, "de-mdy-short")).toBe(yearOf(`02/01/${at}`, "us-short"));
  });

  it("is reachable by the AI column matcher, not only by the dropdown", () => {
    // The callable coerces a suggestion it does not recognise to "de", so a
    // format missing from this list is one auto-detection can never name. The
    // set equality above is what pins it; name the dotted row explicitly
    // because "de" being the fallback makes a miss here look like a success.
    expect([...DATE_FORMATS].sort()).toEqual(DATE_PARSERS.map((p) => p.id).sort());
    expect(DATE_FORMATS).toContain("de");
    expect(DATE_FORMATS).toContain("de-mdy");
    expect(DATE_FORMATS).toContain("de-short");
    expect(DATE_FORMATS).toContain("de-mdy-short");
  });

  it("carries a time, as the slash formats do", () => {
    expect(iso("01.15.26 3:18", "de-mdy-short")).toBe("2026-01-15T00:00:00.000Z");
    expect(analyzeDayMonthOrder(["01.15.26 3:18"])).toBe("month-first");
  });

  it("imports a month-first dotted CSV end to end", async () => {
    const csv = [
      "Buchungstag;Betrag;Name",
      "01.15.26;-25,00;REWE",
      "02.03.26;-12,50;Billa",
      "03.28.26;1.200,00;Honorar",
      "12.01.26;-49,90;A1 Telekom",
    ].join("\n");

    const { headers, rows } = parseCSV(csv, detectCSVFormat(csv));
    const mappings = await autoMatchColumnsRuleBased(headers, rows);
    const date = mappings.find((m) => m.csvColumn === "Buchungstag");

    expect(date?.targetField).toBe("date");
    expect(date?.format).toBe("de-mdy-short");

    // What the import does before writing a Transaction: refuse on a day/month
    // conflict, then parse every row with the chosen format. The row-to-
    // Transaction step itself lives in the React hook and pulls Firebase.
    const column = rows.map((row) => row.Buchungstag);
    expect(findDateColumnConflict(column, date!.format!)).toBeNull();

    const dates = column.map((value) => parseDate(value, date!.format!));

    expect(dates.map((d) => d?.toISOString().split("T")[0])).toEqual([
      "2026-01-15",
      "2026-02-03",
      "2026-03-28",
      "2026-12-01",
    ]);
  });
});
