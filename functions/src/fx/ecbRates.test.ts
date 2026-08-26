import { describe, expect, it } from "vitest";
import {
  MAX_ECB_LOOKBACK_DAYS,
  buildEcbRateTable,
  ecbCrossRate,
  lastPublishedOnOrBefore,
  parseEurofxrefXml,
  shiftIsoDate,
} from "./ecbRates";

/**
 * Three real publication days off the ECB 90-day feed, trimmed to four
 * currencies. 2026-08-22/23 are a Saturday and a Sunday and the ECB published
 * neither, which is the case the statute's "der LETZTE veröffentlichte Kurs"
 * exists for — so it is the fixture rather than a contrived gap.
 */
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
<gesmes:subject>Reference rates</gesmes:subject>
<gesmes:Sender><gesmes:name>European Central Bank</gesmes:name></gesmes:Sender>
<Cube>
<Cube time="2026-08-24"><Cube currency="USD" rate="1.1664"/><Cube currency="JPY" rate="185.6"/><Cube currency="GBP" rate="0.8555"/><Cube currency="CHF" rate="0.9362"/></Cube>
<Cube time="2026-08-21"><Cube currency="USD" rate="1.1699"/><Cube currency="JPY" rate="185.66"/><Cube currency="GBP" rate="0.8567"/><Cube currency="CHF" rate="0.9353"/></Cube>
<Cube time="2026-08-20"><Cube currency="USD" rate="1.1681"/><Cube currency="JPY" rate="185.45"/><Cube currency="GBP" rate="0.85725"/><Cube currency="CHF" rate="0.9333"/></Cube>
</Cube>
</gesmes:Envelope>`;

const table = buildEcbRateTable(parseEurofxrefXml(FEED));

describe("parseEurofxrefXml", () => {
  it("reads every publication day and its rates", () => {
    const days = parseEurofxrefXml(FEED);

    expect(days.map((d) => d.date)).toEqual(["2026-08-24", "2026-08-21", "2026-08-20"]);
    expect(days[0].rates).toEqual({ USD: 1.1664, JPY: 185.6, GBP: 0.8555, CHF: 0.9362 });
  });

  it("skips a row it cannot read rather than failing the feed", () => {
    const days = parseEurofxrefXml(
      `<Cube><Cube time="2026-08-24"><Cube currency="USD" rate="N/A"/>` +
      `<Cube currency="GBP" rate="0.8555"/></Cube></Cube>`
    );

    expect(days).toEqual([{ date: "2026-08-24", rates: { GBP: 0.8555 } }]);
  });

  it("yields nothing for markup that is not the feed", () => {
    expect(parseEurofxrefXml("<html>maintenance</html>")).toEqual([]);
  });
});

describe("buildEcbRateTable", () => {
  it("sorts ascending, so the table can be walked to a date", () => {
    expect(table.days.map((d) => d.date)).toEqual([
      "2026-08-20",
      "2026-08-21",
      "2026-08-24",
    ]);
  });

  it("lets a re-fetched day correct the one already held", () => {
    const corrected = buildEcbRateTable([
      { date: "2026-08-24", rates: { USD: 1.1 } },
      { date: "2026-08-24", rates: { USD: 1.1664 } },
    ]);

    expect(corrected.days).toHaveLength(1);
    expect(corrected.days[0].rates.USD).toBe(1.1664);
  });

  it("drops a day with no usable rate at all", () => {
    expect(buildEcbRateTable([{ date: "2026-08-24", rates: { USD: 0 } }]).days).toEqual([]);
  });
});

describe("lastPublishedOnOrBefore", () => {
  it("uses the day itself when the ECB published it", () => {
    expect(lastPublishedOnOrBefore(table, "2026-08-21")?.date).toBe("2026-08-21");
  });

  it("a Sunday payment reads Friday's rate — the statute says so", () => {
    // § 20 Abs 6 UStG method 2: "den LETZTEN, von der EZB veröffentlichten
    // Umrechnungskurs". 2026-08-23 is a Sunday; 2026-08-21 is the Friday.
    expect(lastPublishedOnOrBefore(table, "2026-08-23")?.date).toBe("2026-08-21");
  });

  it("never reads forward from a date the table starts after", () => {
    expect(lastPublishedOnOrBefore(table, "2026-08-19")).toBeNull();
  });

  it("stops at the lookback bound instead of pricing at the last row it holds", () => {
    const lastDay = "2026-08-24";
    const justInside = shiftIsoDate(lastDay, MAX_ECB_LOOKBACK_DAYS);
    const justOutside = shiftIsoDate(lastDay, MAX_ECB_LOOKBACK_DAYS + 1);

    expect(lastPublishedOnOrBefore(table, justInside)?.date).toBe(lastDay);
    // A table that stopped refreshing must answer "I don't know", not price
    // every later month at its final row (the #111 failure, one layer down).
    expect(lastPublishedOnOrBefore(table, justOutside)).toBeNull();
  });

  it("refuses anything that is not a calendar day", () => {
    expect(lastPublishedOnOrBefore(table, "2026-08")).toBeNull();
  });
});

describe("ecbCrossRate", () => {
  it("quotes EUR per foreign unit by inverting the ECB quote", () => {
    const hit = ecbCrossRate(table, "USD", "EUR", "2026-08-24");

    expect(hit?.rateDate).toBe("2026-08-24");
    expect(hit?.rate).toBeCloseTo(1 / 1.1664, 10);
  });

  it("names the publication day it used, not the day asked for", () => {
    expect(ecbCrossRate(table, "USD", "EUR", "2026-08-23")).toEqual({
      rate: 1 / 1.1699,
      rateDate: "2026-08-21",
    });
  });

  it("crosses two non-EUR currencies through the same publication day", () => {
    const hit = ecbCrossRate(table, "USD", "CHF", "2026-08-24");

    expect(hit?.rate).toBeCloseTo(0.9362 / 1.1664, 10);
  });

  it("treats a missing currency as EUR, like the plausibility gate does", () => {
    expect(ecbCrossRate(table, "USD", null, "2026-08-24")?.rate).toBeCloseTo(
      1 / 1.1664,
      10
    );
  });

  it("has no rate for a pair, a date or a currency it does not carry", () => {
    expect(ecbCrossRate(table, "EUR", "EUR", "2026-08-24")).toBeNull();
    expect(ecbCrossRate(table, "USD", "EUR", "2026-01-14")).toBeNull();
    expect(ecbCrossRate(table, "XAU", "EUR", "2026-08-24")).toBeNull();
  });
});

describe("shiftIsoDate", () => {
  it("crosses a month boundary without a timezone", () => {
    expect(shiftIsoDate("2026-01-03", -7)).toBe("2025-12-27");
    expect(shiftIsoDate("2026-02-28", 1)).toBe("2026-03-01");
  });
});
