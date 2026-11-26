/**
 * FiBuKI asks before it brings in history (#805, spec #800, ADR-0018).
 *
 * After the columns of a CSV Import are matched, the preview counts the rows
 * dated before Tracked From, per fiscal year, and offers three choices: track
 * them as closed, track them as open (only while nothing is closed), or skip
 * them. A choice that moves a setting goes through the settings callable; the
 * Import itself is the unchanged bulkCreateTransactions.
 *
 * Driven through the callables against the self-host in-memory database; what
 * is asserted is what the User sees: the preview, the settings, the change
 * records and the stored rows.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";

// REAL application code, unmodified:
import { handleTool } from "../tools/handlers";
import { getFiscalYearsCallable, updateFiscalYearsCallable } from "../fiscalYears/fiscalYearsCallables";
import {
  dismissUntrackedFilesHintCallable,
  getUntrackedFilesHintCallable,
  previewUntrackedImportCallable,
} from "../fiscalYears/untrackedImportCallables";
import { bulkCreateTransactionsCallable } from "../imports/bulkCreateTransactions";

const db = getFirestore();
const USER = "fy-preview-user";
const AUTH = { uid: USER, token: {} };

type Settings = { startMonth: number; trackedFrom: string; closedThrough: string | null };
type Change = { trackedFrom: string; closedThrough?: string | null };
type Preview = {
  untrackedCount: number;
  untrackedByFiscalYear: Record<string, number>;
  choices: { closed: Change | null; open: Change | null };
};

const run = <T>(callable: { run: (req: never) => unknown }, data: unknown) =>
  callable.run({ data, auth: AUTH } as never) as Promise<T>;

async function settingsOf(): Promise<Settings> {
  return (await run<{ settings: Settings }>(getFiscalYearsCallable, {})).settings;
}

async function records() {
  const snap = await db.collection(`users/${USER}/fiscalYearChanges`).get();
  return snap.docs
    .map((d) => d.data() as { via: string; previous: Settings | null; next: Settings })
    .filter((r) => r.via !== "initial");
}

async function storedDays() {
  const snap = await db.collection("transactions").where("userId", "==", USER).get();
  return snap.docs.map((d) => (d.data()!.date as Timestamp).toDate().toISOString().slice(0, 10)).sort();
}

/** The months of a CSV's rows, as the Import page counts them after column matching. */
function monthsOf(days: string[]): Record<string, number> {
  const months: Record<string, number> = {};
  for (const iso of days) months[iso.slice(0, 7)] = (months[iso.slice(0, 7)] ?? 0) + 1;
  return months;
}

/** The CSV Import's writer, as the Import page calls it. */
function importCsv(days: string[]) {
  return run<{ count: number; untrackedByFiscalYear: Record<string, number> }>(bulkCreateTransactionsCallable, {
    sourceId: "src-1",
    transactions: days.map((iso, i) => ({
      sourceId: "src-1",
      date: `${iso}T00:00:00.000Z`,
      amount: -100 - i,
      currency: "EUR",
      name: `Vendor ${i}`,
      importJobId: "job-1",
      csvRowIndex: i,
      _original: { date: iso, amount: "-1", rawRow: {} },
    })),
  });
}

const CSV = ["2022-03-01", "2022-11-30", "2023-06-15", "2024-02-01", "2024-05-05"];

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
  await db.collection("sources").doc("src-1").set({ userId: USER, name: "Giro", type: "manual", isActive: true });
  await run(updateFiscalYearsCallable, { trackedFrom: "2024-01" });
});

describe("the Import preview", () => {
  it("counts the rows before Tracked From per fiscal year, and writes nothing", async () => {
    const preview = await run<Preview>(previewUntrackedImportCallable, { months: monthsOf(CSV) });

    expect(preview.untrackedCount).toBe(3);
    expect(preview.untrackedByFiscalYear).toEqual({ "2022": 2, "2023": 1 });
    expect(await storedDays()).toEqual([]);
    expect(await records()).toHaveLength(1); // the beforeEach's own change only
  });

  it("asks nothing when no row lies before Tracked From", async () => {
    const preview = await run<Preview>(previewUntrackedImportCallable, { months: monthsOf(["2024-02-01"]) });

    expect(preview.untrackedCount).toBe(0);
    expect(preview.untrackedByFiscalYear).toEqual({});
    expect(preview.choices).toEqual({ closed: null, open: null });
  });

  it("names a fiscal year that does not start in January by both its years", async () => {
    await run(updateFiscalYearsCallable, { startMonth: 7, trackedFrom: "2024-07" });

    const preview = await run<Preview>(previewUntrackedImportCallable, {
      months: monthsOf(["2023-06-30", "2023-07-01", "2024-06-30", "2024-07-01"]),
    });

    expect(preview.untrackedByFiscalYear).toEqual({ "2022/23": 1, "2023/24": 2 });
  });

  it("refuses months that are not months", async () => {
    await expect(run(previewUntrackedImportCallable, { months: { "2024-13": 1 } })).rejects.toMatchObject({
      code: "invalid-argument",
    });
  });
});

describe("the three choices", () => {
  it("track as closed moves Tracked From back over those years, closes them, and imports them", async () => {
    const preview = await run<Preview>(previewUntrackedImportCallable, { months: monthsOf(CSV) });

    await run(updateFiscalYearsCallable, preview.choices.closed);
    const res = await importCsv(CSV);

    expect(await settingsOf()).toEqual({ startMonth: 1, trackedFrom: "2022-01", closedThrough: "2023-12" });
    const recs = await records();
    expect(recs).toHaveLength(2);
    expect(recs.find((r) => r.next.trackedFrom === "2022-01")).toMatchObject({
      via: "settings",
      previous: { trackedFrom: "2024-01", closedThrough: null },
      next: { trackedFrom: "2022-01", closedThrough: "2023-12" },
    });
    expect(res.count).toBe(5);
    expect(res.untrackedByFiscalYear).toEqual({});
    expect(await storedDays()).toEqual(CSV);
  });

  it("track as closed with months already closed only moves Tracked From back", async () => {
    await run(updateFiscalYearsCallable, { closedThrough: "2024-03" });

    const preview = await run<Preview>(previewUntrackedImportCallable, { months: monthsOf(CSV) });
    await run(updateFiscalYearsCallable, preview.choices.closed);

    expect(await settingsOf()).toEqual({ startMonth: 1, trackedFrom: "2022-01", closedThrough: "2024-03" });
  });

  it("track as open moves Tracked From back and imports them as open", async () => {
    const preview = await run<Preview>(previewUntrackedImportCallable, { months: monthsOf(CSV) });

    await run(updateFiscalYearsCallable, preview.choices.open);
    const res = await importCsv(CSV);

    expect(await settingsOf()).toEqual({ startMonth: 1, trackedFrom: "2022-01", closedThrough: null });
    expect(res.count).toBe(5);
    expect(await storedDays()).toEqual(CSV);
  });

  it("track as open is not offered once something is closed", async () => {
    await run(updateFiscalYearsCallable, { closedThrough: "2024-03" });

    const preview = await run<Preview>(previewUntrackedImportCallable, { months: monthsOf(CSV) });

    expect(preview.choices.open).toBeNull();
    expect(preview.choices.closed).not.toBeNull();
  });

  it("skip imports the rest, reports the skipped rows per fiscal year, and changes no setting", async () => {
    const res = await importCsv(CSV);

    expect(res.count).toBe(2);
    expect(res.untrackedByFiscalYear).toEqual({ "2022": 2, "2023": 1 });
    expect(await storedDays()).toEqual(["2024-02-01", "2024-05-05"]);
    expect(await settingsOf()).toEqual({ startMonth: 1, trackedFrom: "2024-01", closedThrough: null });
    expect(await records()).toHaveLength(1);
  });
});

describe("a File dated before Tracked From", () => {
  async function seedFile(id: string, iso: string | null, extra: Record<string, unknown> = {}) {
    await db.collection("files").doc(id).set({
      userId: USER,
      fileName: `${id}.pdf`,
      extractedDate: iso ? Timestamp.fromDate(new Date(`${iso}T00:00:00Z`)) : null,
      transactionIds: [],
      ...extra,
    });
  }
  const hint = () => run<{ count: number; byFiscalYear: Record<string, number> }>(getUntrackedFilesHintCallable, {});
  const dismiss = () => run(dismissUntrackedFilesHintCallable, {});

  it("is kept, and surfaced once as one hint naming the count and fiscal year", async () => {
    await seedFile("f-2021a", "2021-03-01");
    await seedFile("f-2021b", "2021-09-30");
    await seedFile("f-2021c", "2021-12-31");
    await seedFile("f-open", "2024-02-01");
    await seedFile("f-undated", null);
    await seedFile("f-binned", "2021-05-05", { deletedAt: Timestamp.now() });

    expect(await hint()).toEqual({ count: 3, byFiscalYear: { "2021": 3 } });
    expect((await db.collection("files").doc("f-2021a").get()).exists).toBe(true);

    await dismiss();
    expect(await hint()).toEqual({ count: 0, byFiscalYear: {} });
  });

  it("hints again only for documents that arrive after the hint was dismissed", async () => {
    await seedFile("f-2021a", "2021-03-01");
    await hint();
    await dismiss();

    await seedFile("f-2020", "2020-06-01");

    expect(await hint()).toEqual({ count: 1, byFiscalYear: { "2020": 1 } });
  });

  it("appears in no work list", async () => {
    // Even with a suggestion stored before Tracked From moved past it.
    const suggestion = { transactionId: "tx-open", confidence: 99, preview: { name: "Vendor", amount: -100 } };
    await seedFile("f-2021a", "2021-03-01", { transactionMatchComplete: true, transactionSuggestions: [suggestion] });
    await seedFile("f-open", "2024-03-01", { transactionMatchComplete: true, transactionSuggestions: [suggestion] });

    const needing = (await handleTool(USER, "list_transactions_needing_files", {})) as { transactions: unknown[] };
    const pending = (await handleTool(USER, "list_pending_matches", {})) as { matches: Array<{ fileId: string }> };

    expect(needing.transactions).toEqual([]);
    expect(pending.matches.map((m) => m.fileId)).toEqual(["f-open"]);
  });
});

describe("first setup", () => {
  it("writes the fiscal years picked, open or closed, and their record, in one change", async () => {
    const NEW = "fy-new-user";
    const asNew = <T>(callable: { run: (req: never) => unknown }, data: unknown) =>
      callable.run({ data, auth: { uid: NEW, token: {} } } as never) as Promise<T>;

    // What first setup sends for "2022 and 2023 closed, 2024 on open", fiscal years from July.
    const res = await asNew<{ settings: Settings; record: { via: string; next: Settings } }>(updateFiscalYearsCallable, {
      startMonth: 7,
      trackedFrom: "2022-07",
      closedThrough: "2024-06",
    });

    expect(res.settings).toEqual({ startMonth: 7, trackedFrom: "2022-07", closedThrough: "2024-06" });
    expect(res.record).toMatchObject({ via: "settings", next: res.settings });
    const snap = await db.collection(`users/${NEW}/fiscalYearChanges`).get();
    expect(snap.docs.map((d) => d.data()!.via).sort()).toEqual(["initial", "settings"]);
  });
});

describe("imports that never ask", () => {
  it("import_transactions skips and reports, and changes no setting", async () => {
    const res = (await handleTool(USER, "import_transactions", {
      sourceId: "src-1",
      transactions: CSV.map((date, i) => ({ date, amount: -100 - i, name: `Vendor ${i}`, reference: `ref-${i}` })),
    })) as { untrackedByFiscalYear: Record<string, number> };

    expect(res.untrackedByFiscalYear).toEqual({ "2022": 2, "2023": 1 });
    expect(await settingsOf()).toEqual({ startMonth: 1, trackedFrom: "2024-01", closedThrough: null });
    expect(await records()).toHaveLength(1);
  });
});
