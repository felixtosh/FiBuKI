/**
 * #244: the overlay that finds a Transaction for a File gets a sort control
 * (Best match / Closest date / Newest) and two chips (This Partner only, a date
 * window around the File's date). Best match must reproduce the order the
 * overlay had before; Closest date must differ from Newest.
 *
 * #555: the mirror window, Files for a Transaction, uses the same helper with
 * the Transaction's date as reference and Files (some undated) as candidates.
 */

import { describe, expect, it } from "vitest";
import {
  CONNECT_DATE_WINDOW_OPTIONS,
  CONNECT_SORT_OPTIONS,
  DEFAULT_CONNECT_CONTROLS,
  filesSearchNotice,
  filterConnectCandidates,
  rememberConnectControls,
  rememberedConnectControls,
  sortConnectCandidates,
} from "@/lib/matching/connect-candidate-order";

const day = (iso: string) => new Date(`${iso}T00:00:00Z`).getTime();

const TXS = [
  { id: "jan", dateMs: day("2026-01-10"), partnerId: "p-hetzner" },
  { id: "mar-early", dateMs: day("2026-03-01"), partnerId: "p-other" },
  { id: "mar-late", dateMs: day("2026-03-20"), partnerId: "p-hetzner" },
  { id: "sep", dateMs: day("2026-09-20"), partnerId: null },
];
const FILE_DATE = day("2026-03-15");
const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);

describe("sortConnectCandidates", () => {
  const confidence: Record<string, number> = { jan: 60, "mar-early": 85 };
  const confidenceOf = (c: { id: string }) => confidence[c.id];

  it("Best match: scored first by confidence, the rest newest first (today's order)", () => {
    expect(
      ids(sortConnectCandidates(TXS, "best", { confidenceOf, referenceDateMs: FILE_DATE }))
    ).toEqual(["mar-early", "jan", "sep", "mar-late"]);
  });

  it("Closest date: distance from the File's date in both directions", () => {
    expect(
      ids(sortConnectCandidates(TXS, "closest-date", { confidenceOf, referenceDateMs: FILE_DATE }))
    ).toEqual(["mar-late", "mar-early", "jan", "sep"]);
  });

  it("Newest: date descending, distinct from Closest date", () => {
    const newest = ids(sortConnectCandidates(TXS, "newest", { confidenceOf, referenceDateMs: FILE_DATE }));
    expect(newest).toEqual(["sep", "mar-late", "mar-early", "jan"]);
    expect(newest).not.toEqual(
      ids(sortConnectCandidates(TXS, "closest-date", { confidenceOf, referenceDateMs: FILE_DATE }))
    );
  });

  it("does not mutate its input", () => {
    const input = [...TXS];
    sortConnectCandidates(input, "newest", { confidenceOf });
    expect(ids(input)).toEqual(ids(TXS));
  });
});

describe("filterConnectCandidates", () => {
  it("This Partner only keeps the File's Partner", () => {
    expect(ids(filterConnectCandidates(TXS, { partnerId: "p-hetzner" }))).toEqual([
      "jan",
      "mar-late",
    ]);
  });

  it("the date window is relative to the File's date", () => {
    expect(
      ids(filterConnectCandidates(TXS, { dateWindowDays: 7, referenceDateMs: FILE_DATE }))
    ).toEqual(["mar-late"]);
    expect(
      ids(filterConnectCandidates(TXS, { dateWindowDays: 30, referenceDateMs: FILE_DATE }))
    ).toEqual(["mar-early", "mar-late"]);
    expect(
      ids(filterConnectCandidates(TXS, { dateWindowDays: null, referenceDateMs: FILE_DATE }))
    ).toEqual(ids(TXS));
  });

  it("filters nothing by default", () => {
    expect(ids(filterConnectCandidates(TXS, {}))).toEqual(ids(TXS));
  });
});

describe("controls", () => {
  it("offer Best match, Closest date and Newest, and no amount option yet", () => {
    expect(CONNECT_SORT_OPTIONS.map((o) => o.label)).toEqual([
      "Best match",
      "Closest date",
      "Newest",
    ]);
  });

  it("offer ±7, ±30 and all, defaulting to all", () => {
    expect(CONNECT_DATE_WINDOW_OPTIONS.map((o) => o.value)).toEqual([7, 30, null]);
    expect(DEFAULT_CONNECT_CONTROLS).toEqual({
      sort: "best",
      partnerOnly: false,
      dateWindowDays: null,
    });
  });

  it("are remembered in memory for as long as the app is open", () => {
    expect(rememberedConnectControls()).toEqual(DEFAULT_CONNECT_CONTROLS);
    rememberConnectControls({ sort: "newest", partnerOnly: true, dateWindowDays: 7 });
    expect(rememberedConnectControls()).toEqual({
      sort: "newest",
      partnerOnly: true,
      dateWindowDays: 7,
    });
    rememberConnectControls(DEFAULT_CONNECT_CONTROLS);
  });
});

describe("Files as candidates, the Transaction's date as reference (#555)", () => {
  const TX_DATE = day("2026-03-12");
  const FILES = [
    { id: "undated", dateMs: null, partnerId: "p-openai" },
    { id: "jan", dateMs: day("2026-01-05"), partnerId: "p-openai" },
    { id: "mar", dateMs: day("2026-03-10"), partnerId: "p-other" },
    { id: "apr", dateMs: day("2026-04-02"), partnerId: "p-openai" },
  ];
  const confidence: Record<string, number> = { apr: 78, mar: 44 };
  const opts = {
    confidenceOf: (c: { id: string }) => confidence[c.id],
    referenceDateMs: TX_DATE,
  };

  it("Best match: the server's Confidence, then the rest newest first, undated last", () => {
    expect(ids(sortConnectCandidates(FILES, "best", opts))).toEqual([
      "apr",
      "mar",
      "jan",
      "undated",
    ]);
  });

  it("Closest date: either direction from the Transaction's date, undated last", () => {
    expect(ids(sortConnectCandidates(FILES, "closest-date", opts))).toEqual([
      "mar",
      "apr",
      "jan",
      "undated",
    ]);
  });

  it("Newest: date descending, undated last", () => {
    expect(ids(sortConnectCandidates(FILES, "newest", opts))).toEqual([
      "apr",
      "mar",
      "jan",
      "undated",
    ]);
  });

  it("a date window keeps an undated File", () => {
    expect(
      ids(filterConnectCandidates(FILES, { dateWindowDays: 7, referenceDateMs: TX_DATE }))
    ).toEqual(["undated", "mar"]);
  });

  it("This Partner only keeps the Transaction's Partner", () => {
    expect(ids(filterConnectCandidates(FILES, { partnerId: "p-openai" }))).toEqual([
      "undated",
      "jan",
      "apr",
    ]);
  });

  it("remembers its controls apart from the Files-side window's", () => {
    rememberConnectControls({ sort: "closest-date", partnerOnly: false, dateWindowDays: 30 }, "files");
    expect(rememberedConnectControls("files").sort).toBe("closest-date");
    expect(rememberedConnectControls("transactions")).toEqual(DEFAULT_CONNECT_CONTROLS);
    rememberConnectControls(DEFAULT_CONNECT_CONTROLS, "files");
  });
});

/**
 * #598: one search box serves every tab, but only typed text narrows the Files
 * tab. When the box shows something else, the Files tab says so.
 */
describe("filesSearchNotice", () => {
  it("shows nothing for an empty box", () => {
    expect(filesSearchNotice("", "")).toBeNull();
    expect(filesSearchNotice("   ", "")).toBeNull();
  });

  it("shows nothing when the box holds what narrows the Files tab", () => {
    expect(filesSearchNotice("oebb", "oebb")).toBeNull();
    expect(filesSearchNotice("oebb ", "oebb ")).toBeNull();
  });

  it("an auto-filled or chip query with no Files filter: all Files are shown", () => {
    expect(filesSearchNotice("from:oebb.at", "")).toEqual({
      kind: "notApplied",
      boxQuery: "from:oebb.at",
    });
  });

  it("a chip clicked after typing: the Files tab is narrowed by the typed text", () => {
    expect(filesSearchNotice("from:oebb.at", "foo")).toEqual({
      kind: "narrowedBy",
      boxQuery: "from:oebb.at",
      filesQuery: "foo",
    });
  });

  it("compares trimmed text, as the Files filter does", () => {
    expect(filesSearchNotice("oebb", " oebb ")).toBeNull();
    expect(filesSearchNotice(" oebb ", "")).toEqual({ kind: "notApplied", boxQuery: "oebb" });
  });
});
