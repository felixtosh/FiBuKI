/**
 * Tests for the fork #86 whole-account re-match (piece 2).
 *
 * The invariants worth pinning are the safety ones: dry run by default, no
 * false-positive record, auto-only, and a plan over the write cap that aborts
 * whole rather than half-applying.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock factories are hoisted above every const, so the doubles have to be too.
const { partnerUpdate, applyPartnerMatchUpdates, createLocalPartnerFromGlobal } =
  vi.hoisted(() => ({
    partnerUpdate: vi.fn(),
    applyPartnerMatchUpdates: vi.fn(async () => undefined),
    createLocalPartnerFromGlobal: vi.fn(async () => "p-localised"),
  }));

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: vi.fn(() => ({
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({ update: partnerUpdate })),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      startAfter: vi.fn().mockReturnThis(),
      get: vi.fn(async () => ({ empty: true, size: 0, docs: [] })),
    })),
  })),
  FieldValue: {
    serverTimestamp: vi.fn(() => "SERVER_TS"),
    arrayUnion: vi.fn((...entries: unknown[]) => ({ __arrayUnion: entries })),
  },
  Timestamp: { now: vi.fn(() => "NOW") },
}));

vi.mock("../partnerMatchingShared", () => ({
  applyPartnerMatchUpdates,
  loadPartnerMatchingContext: vi.fn(),
}));

vi.mock("../createLocalPartnerFromGlobal", () => ({ createLocalPartnerFromGlobal }));

import {
  decideAction,
  rematchAssignedPartners,
} from "../rematchAssignedPartners";
import * as reportModule from "../partnerRematchReport";
import type {
  AssignedEvaluation,
  RematchClassification,
} from "../partnerRematchReport";

const CONTEXT = {
  partnerContext: {
    userPartners: [],
    filteredGlobalPartners: [],
    partnerManualRemovals: new Map(),
    partnerNameMap: new Map([
      ["p-stored", "S IMMO AG"],
      ["p-other", "esim.me"],
    ]),
  },
  index: { byId: new Map(), localIdByGlobalId: new Map() },
} as unknown as reportModule.RematchContext;

function evaluation(
  id: string,
  classification: Partial<RematchClassification> & {
    verdict: RematchClassification["verdict"];
  }
): AssignedEvaluation {
  return {
    txDoc: { id, ref: { id } },
    txData: { name: id, amount: -1000 },
    stored: {
      transactionId: id,
      partnerId: "p-stored",
      partnerType: "user",
      confidence: 95,
      matchedBy: "auto",
    },
    transaction: { id, partner: null, partnerIban: null, name: id, reference: null },
    assignedAt: "2026-08-01T00:00:00.000Z",
    classification: {
      wouldAssignPartnerId: null,
      topCandidate: null,
      candidates: [],
      ...classification,
    },
  } as unknown as AssignedEvaluation;
}

const reassignTo = (partnerId: string, o: Record<string, unknown> = {}) => ({
  verdict: "different_partner" as const,
  wouldAssignPartnerId: partnerId,
  topCandidate: {
    partnerId,
    partnerName: "esim.me",
    partnerType: "user" as const,
    confidence: 100,
    source: "iban" as const,
    wouldCreateLocalPartner: false,
    ...o,
  },
  candidates: [],
});

/** Drive the op over a fixed set of evaluations. */
function stubScan(evaluations: AssignedEvaluation[]) {
  vi.spyOn(reportModule, "loadRematchContext").mockResolvedValue(CONTEXT);
  vi.spyOn(reportModule, "toRematchRow").mockImplementation(
    (ev) => ({ transactionId: ev.txDoc.id }) as never
  );
  vi.spyOn(reportModule, "evaluateAssignedTransactions").mockImplementation(
    async (_userId, _filters, _context, visit) => {
      for (const ev of evaluations) await visit(ev);
      return {
        scanned: evaluations.length,
        assigned: evaluations.length,
        skippedByMatchedBy: 0,
        assignedWithoutMatchedBy: 0,
        skippedByFilters: 0,
        evaluated: evaluations.length,
        scanLimitReached: false,
      };
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("decideAction", () => {
  it("maps every verdict to an action", () => {
    expect(decideAction("different_partner", true)).toBe("reassign");
    expect(decideAction("below_threshold", true)).toBe("clear");
    expect(decideAction("no_candidates", true)).toBe("clear");
    expect(decideAction("agrees", true)).toBe("keep");
    expect(decideAction("agrees_via_localized_global_name", true)).toBe("keep");
    expect(decideAction("stored_partner_unknown", true)).toBe(
      "skip_stored_partner_unknown"
    );
  });

  it("leaves unconfirmed assignments alone when clearing is off", () => {
    expect(decideAction("below_threshold", false)).toBe("skip_clear_disabled");
    expect(decideAction("no_candidates", false)).toBe("skip_clear_disabled");
  });

  it("never rewrites an assignment the matcher still produces", () => {
    // agrees_via_localized_global_name is a caveat for a human, not a licence
    // for the machine to overwrite the only answer the matcher has.
    expect(decideAction("agrees_via_localized_global_name", false)).toBe("keep");
  });
});

describe("rematchAssignedPartners", () => {
  it("writes nothing by default", async () => {
    stubScan([evaluation("tx1", { verdict: "below_threshold" })]);

    const result = await rematchAssignedPartners("u1", { clearUnconfirmed: true });

    expect(result.dryRun).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.transactionsWritten).toBe(0);
    expect(applyPartnerMatchUpdates).not.toHaveBeenCalled();
    // The plan is still complete, so a caller can review before applying.
    expect(result.actions.clear).toBe(1);
  });

  it("leaves an unconfirmed assignment alone unless clearing is asked for", async () => {
    stubScan([evaluation("tx1", { verdict: "below_threshold" })]);

    const result = await rematchAssignedPartners("u1", { dryRun: false });

    expect(result.applied).toBe(false);
    expect(result.transactionsWritten).toBe(0);
    expect(result.actions.clear).toBe(0);
    expect(result.actions.skip_clear_disabled).toBe(1);
    expect(result.filters.clearUnconfirmed).toBe(false);
    expect(applyPartnerMatchUpdates).not.toHaveBeenCalled();
  });

  it("clears an assignment the matcher no longer reproduces, without a false positive", async () => {
    stubScan([evaluation("tx1", { verdict: "below_threshold" })]);

    const result = await rematchAssignedPartners("u1", {
      dryRun: false,
      clearUnconfirmed: true,
    });

    expect(result.applied).toBe(true);
    expect(result.transactionsWritten).toBe(1);

    const [operations] = applyPartnerMatchUpdates.mock.calls[0] as [
      { updates: Record<string, unknown> }[]
    ];
    expect(operations[0].updates.partnerId).toBeNull();
    expect(operations[0].updates.partnerMatchedBy).toBeNull();

    // The whole point of #86: no manualRemovals write anywhere on this path.
    expect(partnerUpdate).not.toHaveBeenCalled();
  });

  it("records the removal as an automation outcome, not a user decision", async () => {
    stubScan([evaluation("tx1", { verdict: "no_candidates" })]);

    await rematchAssignedPartners("u1", { dryRun: false, clearUnconfirmed: true });

    const [operations] = applyPartnerMatchUpdates.mock.calls[0] as [
      { updates: { automationHistory: { __arrayUnion: Record<string, unknown>[] } } }[]
    ];
    const [entry] = operations[0].updates.automationHistory.__arrayUnion;
    expect(entry.type).toBe("partner_removed");
    expect(entry.actor).toBe("auto");
    expect(entry.level).toBe("outcome");
    expect(entry.forPartnerId).toBe("p-stored");
  });

  it("replaces the stale suggestion list on every write", async () => {
    // The stored suggestions came out of the same buggy run as the assignment,
    // so leaving them would offer the old answer back through the UI.
    stubScan([
      evaluation("tx1", {
        verdict: "below_threshold",
        candidates: [
          {
            partnerId: "p-weak",
            rawPartnerId: "g-weak",
            partnerName: "Weak",
            partnerType: "global",
            confidence: 70,
            source: "name",
            wouldCreateLocalPartner: true,
          },
        ],
      }),
      evaluation("tx2", { verdict: "no_candidates", candidates: [] }),
    ]);

    await rematchAssignedPartners("u1", { dryRun: false, clearUnconfirmed: true });

    const [operations] = applyPartnerMatchUpdates.mock.calls[0] as [
      { updates: Record<string, unknown> }[]
    ];
    // Raw matcher id, matching what the write path stores.
    expect(operations[0].updates.partnerSuggestions).toEqual([
      { partnerId: "g-weak", partnerType: "global", confidence: 70, source: "name" },
    ]);
    expect(operations[1].updates.partnerSuggestions).toEqual([]);
  });

  it("overwrites the assignment when the matcher picks a different partner", async () => {
    stubScan([evaluation("tx1", reassignTo("p-other"))]);

    const result = await rematchAssignedPartners("u1", { dryRun: false });

    const [operations] = applyPartnerMatchUpdates.mock.calls[0] as [
      { updates: Record<string, unknown> }[]
    ];
    expect(operations[0].updates.partnerId).toBe("p-other");
    expect(operations[0].updates.partnerMatchedBy).toBe("auto");
    expect(operations[0].updates.partnerMatchConfidence).toBe(100);
    expect(result.actions.reassign).toBe(1);
    expect(partnerUpdate).not.toHaveBeenCalled();
  });

  it("localises a global preset once, however many rows match it", async () => {
    stubScan([
      evaluation("tx1", reassignTo("g-1", { wouldCreateLocalPartner: true })),
      evaluation("tx2", reassignTo("g-1", { wouldCreateLocalPartner: true })),
    ]);

    const result = await rematchAssignedPartners("u1", { dryRun: false });

    expect(createLocalPartnerFromGlobal).toHaveBeenCalledTimes(1);
    expect(result.localPartnersCreated).toBe(1);
    expect(result.transactionsWritten).toBe(2);

    const [operations] = applyPartnerMatchUpdates.mock.calls[0] as [
      { updates: Record<string, unknown> }[]
    ];
    expect(operations.map((o) => o.updates.partnerId)).toEqual([
      "p-localised",
      "p-localised",
    ]);
  });

  it("skips a row whose preset fails to localise, and says so", async () => {
    createLocalPartnerFromGlobal.mockRejectedValueOnce(new Error("boom"));
    stubScan([
      evaluation("tx1", reassignTo("g-1", { wouldCreateLocalPartner: true })),
      evaluation("tx2", reassignTo("p-other")),
    ]);

    const result = await rematchAssignedPartners("u1", { dryRun: false });

    expect(result.transactionsWritten).toBe(1);
    expect(result.localisationFailures).toBe(1);
  });

  it("leaves agreeing and unknown-partner rows untouched", async () => {
    stubScan([
      evaluation("tx1", { verdict: "agrees" }),
      evaluation("tx2", { verdict: "agrees_via_localized_global_name" }),
      evaluation("tx3", { verdict: "stored_partner_unknown" }),
    ]);

    const result = await rematchAssignedPartners("u1", { dryRun: false });

    expect(result.transactionsWritten).toBe(0);
    expect(applyPartnerMatchUpdates).not.toHaveBeenCalled();
    expect(result.actions.keep).toBe(2);
    expect(result.actions.skip_stored_partner_unknown).toBe(1);
  });

  it("aborts whole rather than applying half a plan over the cap", async () => {
    stubScan([
      evaluation("tx1", { verdict: "below_threshold" }),
      evaluation("tx2", { verdict: "below_threshold" }),
    ]);

    await expect(
      rematchAssignedPartners("u1", {
        dryRun: false,
        maxWrites: 1,
        clearUnconfirmed: true,
      })
    ).rejects.toThrow(/above the maxWrites cap/);

    expect(applyPartnerMatchUpdates).not.toHaveBeenCalled();
  });

  it("only ever selects auto assignments", async () => {
    stubScan([evaluation("tx1", { verdict: "agrees" })]);

    const result = await rematchAssignedPartners("u1");

    expect(result.filters.matchedBy).toEqual(["auto"]);
    const [, filters] = (reportModule.evaluateAssignedTransactions as unknown as {
      mock: { calls: [string, { matchedBy: string[] }][] };
    }).mock.calls[0];
    expect(filters.matchedBy).toEqual(["auto"]);
  });

  it("keeps unconfirmed assignments when clearing is disabled", async () => {
    stubScan([evaluation("tx1", { verdict: "below_threshold" })]);

    const result = await rematchAssignedPartners("u1", {
      dryRun: false,
      clearUnconfirmed: false,
    });

    expect(result.transactionsWritten).toBe(0);
    expect(result.actions.skip_clear_disabled).toBe(1);
    expect(applyPartnerMatchUpdates).not.toHaveBeenCalled();
  });
});
