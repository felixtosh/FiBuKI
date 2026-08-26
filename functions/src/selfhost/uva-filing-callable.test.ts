/**
 * The Q1/Q2 2026 filing, end to end against the corpus (#85).
 *
 * `functions/src/uva/q1q2-2026.test.ts` pins the filing's SHAPE at the pure
 * seam. This one runs the act: seed the records a quarter is made of, call
 * prepareUvaFiling, and check that what comes back — and what is KEPT — is a
 * filing a Steuerberater can sign.
 *
 * Keeping is the half a pure module cannot have. A filing built and discarded
 * cannot be compared against the next one, which is how the D6 sweep's 29
 * weakened records would have read as noise; and a handover nobody recorded is
 * a handover that happens twice. Both live on the stored record here.
 *
 * The corpus anchors are the ticket's own: paperless-ap-1004 (11%
 * Versicherungssteuer), FIBU_20260109-8624 (100% discount), and a USD document
 * settled by card.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";

// REAL application code, unmodified:
import { prepareUvaFilingCallable } from "../reports/prepareUvaFiling";
import type { UvaOpenItem } from "../uva/filing";

const db = getFirestore();
const USER = "stefan-test";
const Q1 = { year: 2026, period: 1, type: "quarterly" as const };
const Q2 = { year: 2026, period: 2, type: "quarterly" as const };

function call(data: unknown, uid: string | null = USER) {
  return prepareUvaFilingCallable.run({
    data,
    auth: uid ? { uid } : undefined,
  } as never);
}

const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00.000Z`));

async function seedTransaction(
  id: string,
  date: string,
  amount: number,
  fileIds: string[] = [],
  extra: Record<string, unknown> = {}
) {
  await db.collection("transactions").doc(id).set({
    userId: USER,
    sourceId: "src-n26",
    date: day(date),
    amount,
    currency: "EUR",
    partner: id,
    fileIds,
    isComplete: fileIds.length > 0,
    ...extra,
  });
}

async function seedFile(id: string, data: Record<string, unknown>) {
  await db.collection("files").doc(id).set({ userId: USER, ...data });
}

/** The Versicherungssteuer document — 11%, 22.00 that must not reach Vorsteuer. */
async function seedInsurance() {
  await seedFile("paperless-ap-1004", {
    extractedAmount: 22200,
    extractedRateGroups: [{ rate: 11, net: 20000, vat: 2200, gross: 22200 }],
    vatNotClaimableReason: "insurance-tax",
  });
  await seedTransaction("t-ap-1004", "2026-02-18", -22200, ["paperless-ap-1004"]);
}

/** The 100% discount — EUR 0 due, so nothing to deduct. */
async function seedDiscounted() {
  await seedFile("FIBU_20260109-8624", {
    extractedAmount: 12000,
    extractedVatAmount: 2000,
    extractedVatPercent: 20,
    vatNotClaimableReason: "discount-to-zero",
  });
  await seedTransaction("t-fibu-8624", "2026-01-09", -12000, ["FIBU_20260109-8624"]);
}

/** A USD document settled by card: read at the effective rate the payment carried. */
async function seedUsd() {
  await seedFile("usd-1", {
    extractedAmount: 3822,
    extractedCurrency: "USD",
    extractedRateGroups: [{ rate: 20, net: 3185, vat: 637, gross: 3822 }],
  });
  await seedTransaction("t-usd-1", "2026-01-14", -3325, ["usd-1"]);
}

/** A plain domestic expense, 20% off a printed rate-group block. */
async function seedDomestic(id = "f-domestic", vat = 2000) {
  await seedFile(id, {
    extractedAmount: 12000,
    extractedRateGroups: [{ rate: 20, net: 12000 - vat, vat, gross: 12000 }],
  });
  await seedTransaction(`t-${id}`, "2026-02-01", -12000, [id]);
}

const OPEN_ITEM: UvaOpenItem = {
  ref: "OEBBTicket",
  summary: "Fare total 73.80 present, but the document carries no VAT rate",
  disposition: "deferred",
  rationale:
    "Austrian passenger rail is 10% (§ 10 Abs 2 UStG), but the rate is not " +
    "printed and the original ruling did not cover this class, so claiming it " +
    "is an operator decision rather than a derivation.",
  effect: { inputVat: 671, outputVat: 0 },
};

beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 20));
  await __resetFirestoreShim();
  __resetTriggerShim();
  await db.collection("sources").doc("src-n26").set({
    userId: USER,
    name: "N26 Business",
    type: "manual",
    isActive: true,
  });
  await drainTriggers();
});

describe("prepareUvaFiling: the quarter derived from the corpus", () => {
  it("rejects unauthenticated calls through the unmodified createCallable wrapper", async () => {
    await expect(call({ period: Q1 }, null)).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  it("puts a payment in the quarter the money moved, not the quarter it was invoiced", async () => {
    // Ist-Besteuerung (R3): the corpus has no invoice date to read — the bank
    // movement is the only date in the record, so the basis is structural.
    await seedFile("f-january-invoice", {
      extractedAmount: 12000,
      extractedVatAmount: 2000,
      extractedVatPercent: 20,
    });
    await seedTransaction("t-paid-in-april", "2026-04-02", -12000, ["f-january-invoice"]);

    const q1 = await call({ period: Q1 });
    const q2 = await call({ period: Q2 });

    expect(q1.filing.report.derivations).toHaveLength(0);
    expect(q1.filing.report.totalInputVat).toBe(0);
    expect(q2.filing.report.totalInputVat).toBe(2000);
    expect(q2.filing.basis).toBe("ist");
    expect(q2.filing.report.period).toMatchObject({
      start: "2026-04-01",
      end: "2026-06-30",
    });
  });

  it("carries the quarter's exceptions with the statute that allows each one", async () => {
    await seedInsurance();
    await seedDiscounted();
    await seedUsd();

    const { filing } = await call({ period: Q1 });
    const byReason = Object.fromEntries(
      filing.exceptions.map((e) => [e.reason ?? e.kind, e])
    );

    // All three are read OFF the corpus — two #203 markers on the file records
    // and the conversion the derivation performed — so re-running the quarter
    // reproduces them without anyone remembering.
    expect(byReason["insurance-tax"].fileIds).toEqual(["paperless-ap-1004"]);
    expect(byReason["insurance-tax"].amount).toBe(2200);
    expect(byReason["insurance-tax"].basis).toContain("§ 6 Abs 1 Z 9 lit. c UStG");
    expect(byReason["discount-to-zero"].fileIds).toEqual(["FIBU_20260109-8624"]);
    expect(byReason["discount-to-zero"].amount).toBe(2000);
    expect(byReason["fx-effective-rate"].basis).toContain("§ 20 Abs 6 UStG method 3");
    // The bounded cost of the method: 1-3% of the converted claim.
    expect(byReason["fx-effective-rate"].exposure).toEqual({ low: 6, high: 17 });

    // 22.00 + 20.00 stay out of Vorsteuer, and neither reads as a gap.
    expect(filing.report.totalInputVat).toBe(554);
    expect(filing.blockers).toEqual([]);
  });

  it("traces every claimed cent to a file, and blocks on one that rests on none", async () => {
    await seedDomestic();
    // The manual override lane: a rate typed on the transaction, no receipt.
    await seedTransaction("t-typed", "2026-03-20", -6000, [], { vatRate: 20 });

    const { filing } = await call({ period: Q1 });

    expect(filing.vorsteuer.reconciles).toBe(true);
    expect(filing.vorsteuer.traced.map((t) => t.fileIds).flat()).toEqual(["f-domestic"]);
    expect(filing.vorsteuer.untraced).toHaveLength(1);
    expect(filing.vorsteuer.untraced[0]).toMatchObject({
      transactionId: "t-typed",
      basis: "no-document",
      vat: 1000,
    });
    // Listed rather than dropped, and the filing refuses to go out over it.
    expect(filing.blockers.map((b) => b.code)).toEqual(["vorsteuer-undocumented"]);
  });
});

describe("prepareUvaFiling: the baseline a later run is judged against", () => {
  it("establishes the baseline on the first preparation, and claims no comparison", async () => {
    await seedDomestic();

    const first = await call({ period: Q1 });

    expect(first.baseline).toEqual({ origin: "established", periodKey: null });
    // A self-diff showing no movement would read as "compared and clean" while
    // nothing was compared at all.
    expect(first.filing.reconciliation).toBeNull();
  });

  it("explains a later run per file, and separates a weaker figure from a better source", async () => {
    // The D6 sweep's two outcomes: one document gained its printed rate-group
    // block (better reading), one came back weaker off the same rung.
    await seedFile("f-improved", {
      extractedAmount: 12000,
      extractedVatAmount: 2000,
      extractedVatPercent: 20,
    });
    await seedTransaction("t-improved", "2026-02-01", -12000, ["f-improved"]);
    await seedFile("f-weaker", {
      extractedAmount: 6000,
      extractedRateGroups: [{ rate: 20, net: 5000, vat: 1000, gross: 6000 }],
    });
    await seedTransaction("t-weaker", "2026-02-02", -6000, ["f-weaker"]);
    await call({ period: Q1 });

    // Re-extraction moves both documents.
    await db.collection("files").doc("f-improved").update({
      extractedRateGroups: [{ rate: 20, net: 10000, vat: 2000, gross: 12000 }],
    });
    await db.collection("files").doc("f-weaker").update({
      extractedRateGroups: [{ rate: 20, net: 5200, vat: 800, gross: 6000 }],
    });

    const { filing, baseline } = await call({ period: Q1 });
    const byId = Object.fromEntries(
      filing.reconciliation!.movements.map((m) => [m.transactionId, m])
    );

    expect(baseline).toEqual({ origin: "stored", periodKey: "2026-Q1" });
    expect(byId["t-improved"].kind).toBe("source-changed");
    expect(byId["t-improved"].fileIds).toEqual(["f-improved"]);
    expect(byId["t-weaker"].kind).toBe("figure-changed");
    expect(byId["t-weaker"].fileIds).toEqual(["f-weaker"]);
    expect(byId["t-weaker"].inputVatDelta).toBe(-200);
    expect(filing.reconciliation!.accountedFor).toBe(true);
    expect(filing.reconciliation!.totals.inputVatDelta).toBe(-200);
  });

  it("takes a baseline that predates the record — the pre-sweep run", async () => {
    await seedDomestic("f-domestic", 2000);

    const preSweep = {
      periodKey: "2026-Q1",
      entries: [
        {
          transactionId: "t-f-domestic",
          date: "2026-02-01",
          partner: "t-f-domestic",
          amount: -12000,
          side: "expense" as const,
          step: "top-level" as const,
          reason: null,
          fileIds: ["f-domestic"],
          outputVat: 0,
          inputVat: 1800,
        },
      ],
      totalInputVat: 1800,
      totalOutputVat: 0,
      balance: -1800,
    };

    const { filing, baseline } = await call({ period: Q1, baseline: preSweep });

    expect(baseline).toEqual({ origin: "supplied", periodKey: "2026-Q1" });
    expect(filing.reconciliation!.totals.inputVatDelta).toBe(200);
    expect(filing.reconciliation!.movements[0].kind).toBe("source-changed");
    // It replaces the kept one, so the next run measures against it too.
    const again = await call({ period: Q1 });
    expect(again.baseline.origin).toBe("stored");
    expect(again.filing.reconciliation!.totals.inputVatDelta).toBe(200);
  });

  it("refuses a baseline from another period rather than diffing across quarters", async () => {
    await seedDomestic();

    await expect(
      call({
        period: Q1,
        baseline: {
          periodKey: "2026-Q2",
          entries: [],
          totalInputVat: 0,
          totalOutputVat: 0,
          balance: 0,
        },
      })
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });
});

describe("prepareUvaFiling: open items and the handover", () => {
  it("keeps the declared open items across preparations", async () => {
    await seedDomestic();

    await call({ period: Q1, openItems: [OPEN_ITEM] });
    const { filing } = await call({ period: Q1 });

    expect(filing.openItems).toHaveLength(1);
    expect(filing.openItems[0]).toMatchObject({
      ref: "OEBBTicket",
      disposition: "deferred",
      effect: { inputVat: 671, outputVat: 0 },
    });
    expect(filing.blockers).toEqual([]);
  });

  it("blocks on a deferral with no rationale — a silent one repeats next quarter", async () => {
    await seedDomestic();

    const { filing } = await call({
      period: Q1,
      openItems: [{ ...OPEN_ITEM, rationale: "  " }],
    });

    expect(filing.blockers.map((b) => b.code)).toEqual(["open-item-unexplained"]);
  });

  it("rejects an open item with no stated effect on the figures", async () => {
    await seedDomestic();

    await expect(
      call({
        period: Q1,
        openItems: [{ ...OPEN_ITEM, effect: undefined }],
      })
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("records who received the filing, when, and how", async () => {
    await seedDomestic();

    const { filing } = await call({
      period: Q1,
      openItems: [OPEN_ITEM],
      handover: { state: "handed-over", to: "Stefan", at: "2026-08-24", via: "e-mail" },
    });

    expect(filing.handover).toEqual({
      state: "handed-over",
      to: "Stefan",
      at: "2026-08-24",
      via: "e-mail",
    });
    const stored = (
      await db.collection("uvaFilings").doc(`${USER}_2026-Q1`).get()
    ).data();
    expect(stored?.handover).toMatchObject({ state: "handed-over", to: "Stefan" });
    expect(stored?.handoverCovers).toMatchObject({ balance: filing.report.balance });
  });

  it("has no state that means submitted, and will not invent one", async () => {
    await seedDomestic();

    await expect(
      call({ period: Q1, handover: { state: "submitted", to: "FinanzOnline" } })
    ).rejects.toMatchObject({ code: "invalid-argument" });
    // Submission stays the separate, user-triggered submitUvaToFinanzOnline
    // path; nothing on this one reaches it.
    const { filing } = await call({ period: Q1 });
    expect(filing.handover).toEqual({ state: "prepared" });
  });

  it("will not record a handover for a filing that is blocked", async () => {
    await seedDomestic();
    await seedTransaction("t-typed", "2026-03-20", -6000, [], { vatRate: 20 });

    await expect(
      call({
        period: Q1,
        handover: { state: "handed-over", to: "Stefan", at: "2026-08-24", via: "e-mail" },
      })
    ).rejects.toMatchObject({ code: "failed-precondition" });
    const stored = await db.collection("uvaFilings").doc(`${USER}_2026-Q1`).get();
    // Nothing is kept either: a rejected handover must not leave a record
    // behind that a later run would treat as this period's baseline.
    expect(stored.exists).toBe(false);
  });

  it("marks the recorded handover stale once the figures move under it", async () => {
    await seedDomestic();
    await call({
      period: Q1,
      handover: { state: "handed-over", to: "Stefan", at: "2026-08-24", via: "e-mail" },
    });

    // A late correction to a document Stefan already has.
    await db.collection("files").doc("f-domestic").update({
      extractedRateGroups: [{ rate: 20, net: 10500, vat: 1500, gross: 12000 }],
    });
    const { filing } = await call({ period: Q1 });

    expect(filing.handover).toMatchObject({ state: "handed-over", to: "Stefan" });
    // The record must not keep saying Stefan received THIS filing when what he
    // received is a different set of figures.
    expect(filing.blockers.map((b) => b.code)).toContain("handover-stale");
  });
});
