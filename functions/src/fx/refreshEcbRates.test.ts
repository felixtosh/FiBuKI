import { describe, expect, it } from "vitest";
import { FakeFirestore } from "../api-smoke/fake-firestore";
import {
  ECB_HISTORY_FEED_URL,
  ECB_RECENT_FEED_URL,
  refreshEcbReferenceRates,
} from "./refreshEcbRates";
import { loadEcbRateTable } from "./ecbRateStore";
import { ecbCrossRate } from "./ecbRates";

const asDb = (fake: FakeFirestore) => fake as unknown as FirebaseFirestore.Firestore;

const FEED = `<Cube>
<Cube time="2026-08-24"><Cube currency="USD" rate="1.1664"/></Cube>
<Cube time="2026-08-21"><Cube currency="USD" rate="1.1699"/></Cube>
</Cube>`;

/** Records the URL asked for and answers with `body`. */
function stubFetch(body: string, status = 200) {
  const urls: string[] = [];
  const impl = (async (url: string) => {
    urls.push(String(url));
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  }) as unknown as typeof fetch;
  return { impl, urls };
}

describe("refreshEcbReferenceRates", () => {
  it("seeds from the full history when the store has never been refreshed", async () => {
    const fake = new FakeFirestore();
    const { impl, urls } = stubFetch(FEED);

    const result = await refreshEcbReferenceRates(asDb(fake), { fetchImpl: impl });

    expect(urls).toEqual([ECB_HISTORY_FEED_URL]);
    expect(result).toMatchObject({ window: "history", fetched: 2, months: 1, days: 2 });
    expect(result.latest).toBe("2026-08-24");
  });

  it("takes the 90-day window once something is stored", async () => {
    const fake = new FakeFirestore();
    await refreshEcbReferenceRates(asDb(fake), { fetchImpl: stubFetch(FEED).impl });

    const { impl, urls } = stubFetch(FEED);
    const result = await refreshEcbReferenceRates(asDb(fake), { fetchImpl: impl });

    expect(urls).toEqual([ECB_RECENT_FEED_URL]);
    expect(result.window).toBe("recent");
  });

  it("honours an explicit window over the seed decision", async () => {
    const fake = new FakeFirestore();
    const { impl, urls } = stubFetch(FEED);

    await refreshEcbReferenceRates(asDb(fake), { fetchImpl: impl, window: "recent" });

    expect(urls).toEqual([ECB_RECENT_FEED_URL]);
  });

  it("leaves the rates queryable by payment date", async () => {
    const fake = new FakeFirestore();
    await refreshEcbReferenceRates(asDb(fake), { fetchImpl: stubFetch(FEED).impl });

    const table = await loadEcbRateTable(asDb(fake), "2026-08-01", "2026-08-31");

    expect(ecbCrossRate(table, "USD", "EUR", "2026-08-24")?.rate).toBeCloseTo(
      1 / 1.1664,
      10
    );
  });

  it("throws on a feed that answers, but not with the feed", async () => {
    // A 200 that parses to nothing means the markup changed. Writing zero days
    // and reporting success would leave a stale table looking refreshed.
    const fake = new FakeFirestore();

    await expect(
      refreshEcbReferenceRates(asDb(fake), { fetchImpl: stubFetch("<html/>").impl })
    ).rejects.toThrow(/carried no publication days/);
  });

  it("throws on a non-2xx rather than clearing anything", async () => {
    const fake = new FakeFirestore();

    await expect(
      refreshEcbReferenceRates(asDb(fake), { fetchImpl: stubFetch("", 503).impl })
    ).rejects.toThrow(/503/);
  });
});
