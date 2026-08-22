/**
 * Backup round-trip for the partner billing cycle (#171).
 *
 * The export writes one CSV cell per partner field and the import reads it
 * back, so the two halves only agree if the column exists on both sides. These
 * tests drive the real `generateCsv`/`parseCsv` pair rather than a stub: the
 * failure mode guarded against is a declared cycle that leaves the box in a
 * backup and never comes back.
 */

import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase-admin/firestore";

import { generateCsv, partnersColumns } from "../csvGenerators";
import { parseCsv, prepareDocForImport } from "../../user-import/csvParsers";

/** The stored cycle as a restored partner carries it. */
interface RestoredBillingCycle {
  learned: Array<Record<string, unknown> & { learnedAt: Timestamp }>;
  declared: Array<Record<string, unknown>>;
  effective: Array<Record<string, unknown>>;
}

/** Export a partner and import it back, as the ZIP lane does. */
function roundTrip(partner: Record<string, unknown>): Record<string, unknown> {
  const csv = generateCsv([partner], partnersColumns);
  const [imported] = parseCsv(csv);
  return prepareDocForImport(imported, "user-1");
}

const learnedAt = Timestamp.fromDate(new Date("2026-08-01T09:30:00.000Z"));

/** Anthropic-shaped: a weekly API band beside a declared monthly subscription. */
const billingCycle = {
  learned: [
    {
      amountBand: 38.25,
      frequencyDays: 7,
      frequencyConfidence: 88,
      typicalDayOfMonth: 6,
      dayVariance: 1,
      invoiceToTransactionDelay: 2,
      delayVariance: 1,
      sampleSize: 9,
      learnedAt,
    },
    { amountBand: 90, frequencyDays: 30, frequencyConfidence: 74, sampleSize: 4, learnedAt },
  ],
  declared: [
    {
      amountBand: 90,
      frequencyDays: 30,
      expectedAmountMin: 85,
      expectedAmountMax: 95,
      currency: "USD",
      documentExpectation: "invoice",
    },
  ],
  effective: [
    { amountBand: 38.25, source: "learned", frequencyDays: 7, frequencyConfidence: 88 },
    { amountBand: 90, source: "declared", frequencyDays: 30, documentExpectation: "invoice" },
  ],
};

const partner = {
  id: "partner-anthropic",
  name: "Anthropic PBC",
  aliases: ["Anthropic, PBC"],
  isActive: true,
  billingCycle,
  createdAt: Timestamp.fromDate(new Date("2026-01-04T00:00:00.000Z")),
};

describe("partner billing cycle survives an export/import round trip", () => {
  it("exports a billingCycle column", () => {
    const csv = generateCsv([partner], partnersColumns);

    expect(csv.split("\n")[0].split(",")).toContain("billingCycle");
    expect(csv).toContain("documentExpectation");
  });

  it("restores the declared cycle with its amount band", () => {
    const restored = roundTrip(partner).billingCycle as RestoredBillingCycle;

    expect(restored.declared).toEqual([
      {
        amountBand: 90,
        frequencyDays: 30,
        expectedAmountMin: 85,
        expectedAmountMax: 95,
        currency: "USD",
        documentExpectation: "invoice",
      },
    ]);
  });

  it("restores both learned recurrences with sample size and confidence", () => {
    const restored = roundTrip(partner).billingCycle as RestoredBillingCycle;

    expect(restored.learned).toHaveLength(2);
    expect(restored.learned[0]).toMatchObject({
      amountBand: 38.25,
      frequencyDays: 7,
      frequencyConfidence: 88,
      typicalDayOfMonth: 6,
      dayVariance: 1,
      invoiceToTransactionDelay: 2,
      delayVariance: 1,
      sampleSize: 9,
    });
    expect(restored.learned[1]).toMatchObject({
      amountBand: 90,
      frequencyConfidence: 74,
      sampleSize: 4,
    });
  });

  it("restores learnedAt as a Timestamp, not as the encoded object", () => {
    const restored = roundTrip(partner).billingCycle as RestoredBillingCycle;

    // A plain {_seconds,_nanoseconds} here reads as "never learned" downstream.
    expect(restored.learned[0].learnedAt).toBeInstanceOf(Timestamp);
    expect(restored.learned[0].learnedAt.toDate().toISOString()).toBe(
      "2026-08-01T09:30:00.000Z"
    );
  });

  it("keeps the effective view, so the import needs no re-derivation", () => {
    const restored = roundTrip(partner).billingCycle as RestoredBillingCycle;

    expect(restored.effective).toEqual(billingCycle.effective);
  });

  it("invents no cycle for a partner that has none", () => {
    const restored = roundTrip({ id: "partner-plain", name: "Bäckerei Müller", isActive: true });

    expect(restored.billingCycle).toBeNull();
    expect(restored.name).toBe("Bäckerei Müller");
  });
});
