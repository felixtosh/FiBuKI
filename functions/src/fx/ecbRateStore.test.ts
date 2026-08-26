import { describe, expect, it } from "vitest";
import { FakeFirestore } from "../api-smoke/fake-firestore";
import {
  ECB_RATES_COLLECTION,
  ECB_RATES_SOURCE,
  ecbRateStoreIsEmpty,
  loadEcbRateTable,
  storeEcbDays,
} from "./ecbRateStore";
import { ecbCrossRate } from "./ecbRates";

const asDb = (fake: FakeFirestore) => fake as unknown as FirebaseFirestore.Firestore;

/** Real ECB quotes, USD per EUR, on days either side of a month boundary. */
const DAYS = [
  { date: "2026-08-20", rates: { USD: 1.1681 } },
  { date: "2026-08-21", rates: { USD: 1.1699 } },
  { date: "2026-08-24", rates: { USD: 1.1664 } },
  { date: "2026-07-31", rates: { USD: 1.1449 } },
];

describe("storeEcbDays", () => {
  it("keys a document per month, with the feed named on it", async () => {
    const fake = new FakeFirestore();

    const result = await storeEcbDays(asDb(fake), DAYS);

    expect(result).toEqual({ months: 2, days: 4 });
    const august = fake as unknown as { _raw(c: string, id: string): Record<string, unknown> };
    const doc = august._raw(ECB_RATES_COLLECTION, "2026-08") as {
      month: string;
      source: string;
      days: Record<string, Record<string, number>>;
    };
    expect(doc.month).toBe("2026-08");
    expect(doc.source).toBe(ECB_RATES_SOURCE);
    expect(Object.keys(doc.days).sort()).toEqual([
      "2026-08-20",
      "2026-08-21",
      "2026-08-24",
    ]);
  });

  it("keeps the days already stored for a month a later refresh does not carry", async () => {
    const fake = new FakeFirestore();
    await storeEcbDays(asDb(fake), DAYS);

    // The 90-day feed always re-sends an overlapping window; a refresh must
    // add to a month, not replace it.
    await storeEcbDays(asDb(fake), [{ date: "2026-08-25", rates: { USD: 1.17 } }]);

    // The window is widened by the lookback, so July's document comes along;
    // it costs one read and a date lookup ignores what it does not ask for.
    const table = await loadEcbRateTable(asDb(fake), "2026-08-01", "2026-08-31");
    expect(table.days.map((d) => d.date)).toEqual([
      "2026-07-31",
      "2026-08-20",
      "2026-08-21",
      "2026-08-24",
      "2026-08-25",
    ]);
  });

  it("lets a corrected day overwrite the one held", async () => {
    const fake = new FakeFirestore();
    await storeEcbDays(asDb(fake), [{ date: "2026-08-24", rates: { USD: 1.1 } }]);

    await storeEcbDays(asDb(fake), [{ date: "2026-08-24", rates: { USD: 1.1664 } }]);

    const table = await loadEcbRateTable(asDb(fake), "2026-08-24", "2026-08-24");
    expect(table.days[0].rates.USD).toBe(1.1664);
  });

  it("writes nothing for days it cannot key to a month", async () => {
    const fake = new FakeFirestore();

    expect(await storeEcbDays(asDb(fake), [{ date: "August", rates: { USD: 1.1 } }]))
      .toEqual({ months: 0, days: 0 });
  });
});

describe("loadEcbRateTable", () => {
  it("reaches back past the period start, so 1 January can read 30 December", async () => {
    const fake = new FakeFirestore();
    await storeEcbDays(asDb(fake), [
      { date: "2025-12-30", rates: { USD: 1.05 } },
      { date: "2026-01-02", rates: { USD: 1.06 } },
    ]);

    const table = await loadEcbRateTable(asDb(fake), "2026-01-01", "2026-03-31");

    // A 1 January payment: the ECB published neither that day nor the 31st.
    expect(ecbCrossRate(table, "USD", "EUR", "2026-01-01")).toEqual({
      rate: 1 / 1.05,
      rateDate: "2025-12-30",
    });
  });

  it("is empty rather than absent when nothing has been refreshed", async () => {
    const fake = new FakeFirestore();

    expect(await loadEcbRateTable(asDb(fake), "2026-01-01", "2026-03-31")).toEqual({
      days: [],
    });
  });
});

describe("ecbRateStoreIsEmpty", () => {
  it("is the seed signal: true before the first refresh, false after", async () => {
    const fake = new FakeFirestore();
    expect(await ecbRateStoreIsEmpty(asDb(fake))).toBe(true);

    await storeEcbDays(asDb(fake), DAYS);

    expect(await ecbRateStoreIsEmpty(asDb(fake))).toBe(false);
  });
});
