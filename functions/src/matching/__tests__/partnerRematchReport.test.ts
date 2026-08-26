/**
 * Tests for the fork #86 re-match disagreement report.
 *
 * The Firestore paging is a thin wrapper; the part worth pinning is the
 * classifier — it decides whether a stale assignment is a disagreement, and a
 * wrong verdict here either hides a bad assignment or sends a human to review a
 * correct one.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: vi.fn(() => ({})),
  FieldValue: { serverTimestamp: vi.fn() },
  Timestamp: { now: vi.fn() },
}));

import {
  buildPartnerIndex,
  classifyRematch,
  isDisagreement,
  readAssignedAt,
  scoreStoredPartner,
  StoredAssignment,
} from "../partnerRematchReport";
import type { PartnerMatchingContext } from "../partnerMatchingShared";
import {
  AUTO_APPLY_THRESHOLD,
  MatchResult,
  PartnerData,
  TransactionData,
} from "../../utils/partner-matcher";

const partner = (o: Partial<PartnerData> & { id: string }): PartnerData => ({
  name: o.id,
  aliases: [],
  ibans: [],
  ...o,
});

const context = (o: Partial<PartnerMatchingContext> = {}): PartnerMatchingContext => ({
  userPartners: [],
  filteredGlobalPartners: [],
  partnerManualRemovals: new Map(),
  partnerNameMap: new Map(),
  ...o,
});

const match = (o: Partial<MatchResult> & { partnerId: string }): MatchResult => ({
  partnerType: "user",
  partnerName: o.partnerId,
  confidence: 95,
  source: "name",
  ...o,
});

const stored = (o: Partial<StoredAssignment> = {}): StoredAssignment => ({
  transactionId: "tx1",
  partnerId: "p-stored",
  partnerType: "user",
  confidence: 95,
  matchedBy: "auto",
  ...o,
});

describe("classifyRematch", () => {
  it("agrees when the matcher would auto-apply the stored partner", () => {
    const index = buildPartnerIndex(
      context({ userPartners: [partner({ id: "p-stored", name: "Uber Technologies" })] })
    );

    const result = classifyRematch(
      stored(),
      [match({ partnerId: "p-stored", confidence: 94 })],
      index
    );

    expect(result.verdict).toBe("agrees");
    expect(result.wouldAssignPartnerId).toBe("p-stored");
    expect(isDisagreement(result.verdict)).toBe(false);
  });

  it("reports a different partner when the matcher would apply another one", () => {
    const index = buildPartnerIndex(
      context({
        userPartners: [partner({ id: "p-stored" }), partner({ id: "p-other" })],
      })
    );

    const result = classifyRematch(
      stored(),
      [match({ partnerId: "p-other", confidence: 100, source: "iban" })],
      index
    );

    expect(result.verdict).toBe("different_partner");
    expect(result.wouldAssignPartnerId).toBe("p-other");
    expect(isDisagreement(result.verdict)).toBe(true);
  });

  it("reports below_threshold when nothing reaches the auto-apply gate", () => {
    const index = buildPartnerIndex(
      context({ userPartners: [partner({ id: "p-stored" })] })
    );

    const result = classifyRematch(
      stored({ confidence: 95 }),
      [match({ partnerId: "p-stored", confidence: AUTO_APPLY_THRESHOLD - 1 })],
      index
    );

    // The 92-95 band the #71 bug minted lands here: still the top candidate,
    // but no longer strong enough to have been assigned unreviewed.
    expect(result.verdict).toBe("below_threshold");
    expect(result.wouldAssignPartnerId).toBeNull();
    expect(result.topCandidate?.confidence).toBe(AUTO_APPLY_THRESHOLD - 1);
  });

  it("reports below_threshold, not different_partner, when a rival leads weakly", () => {
    const index = buildPartnerIndex(
      context({
        userPartners: [partner({ id: "p-stored" }), partner({ id: "p-other" })],
      })
    );

    const result = classifyRematch(
      stored(),
      [match({ partnerId: "p-other", confidence: 80 })],
      index
    );

    // The matcher would assign nothing at all, which is the accurate statement.
    expect(result.verdict).toBe("below_threshold");
    expect(result.wouldAssignPartnerId).toBeNull();
  });

  it("reports no_candidates when the matcher returns nothing", () => {
    const index = buildPartnerIndex(
      context({ userPartners: [partner({ id: "p-stored" })] })
    );

    const result = classifyRematch(stored(), [], index);

    expect(result.verdict).toBe("no_candidates");
    expect(result.topCandidate).toBeNull();
    expect(isDisagreement(result.verdict)).toBe(true);
  });

  it("reports stored_partner_unknown when the stored partner is gone", () => {
    const index = buildPartnerIndex(
      context({ userPartners: [partner({ id: "p-other" })] })
    );

    const result = classifyRematch(
      stored({ partnerId: "p-deleted" }),
      [match({ partnerId: "p-other" })],
      index
    );

    expect(result.verdict).toBe("stored_partner_unknown");
    expect(isDisagreement(result.verdict)).toBe(true);
  });

  it("does not call a localisation a partner change", () => {
    // Guard, not a live path: loadPartnerMatchingContext drops any global preset
    // that already has a local copy from the candidate pool, so this shape
    // cannot occur today. It is pinned because that pool rule lives in another
    // function, and relaxing it there must not silently turn a localisation into
    // a reported partner change.
    const index = buildPartnerIndex(
      context({
        userPartners: [partner({ id: "p-local", globalPartnerId: "g-1" })],
      })
    );

    const result = classifyRematch(
      stored({ partnerId: "p-local" }),
      [match({ partnerId: "g-1", partnerType: "global", confidence: 100, source: "iban" })],
      index
    );

    expect(result.verdict).toBe("agrees");
    expect(result.topCandidate?.partnerId).toBe("p-local");
    expect(result.topCandidate?.wouldCreateLocalPartner).toBe(false);
  });

  it("treats a global match with no local copy as a partner change", () => {
    const index = buildPartnerIndex(
      context({ userPartners: [partner({ id: "p-stored" })] })
    );

    const result = classifyRematch(
      stored(),
      [match({ partnerId: "g-2", partnerType: "global", confidence: 100, source: "iban" })],
      index
    );

    expect(result.verdict).toBe("different_partner");
    expect(result.topCandidate?.wouldCreateLocalPartner).toBe(true);
    // The id of the partner document it would create is not knowable up front.
    expect(result.wouldAssignPartnerId).toBeNull();
  });

  it("flags agreement carried by a name match on a localised global preset", () => {
    // GLOBAL_APPROXIMATE_NAME_CAP applies to partnerType "global" only. Once the
    // #71 matcher localised a preset into the user list, the same approximate
    // name evidence scores uncapped, so agreement is not proof the assignment
    // was sound.
    const index = buildPartnerIndex(
      context({
        userPartners: [partner({ id: "p-local", globalPartnerId: "g-1" })],
      })
    );

    const result = classifyRematch(
      stored({ partnerId: "p-local" }),
      [match({ partnerId: "p-local", confidence: 90, source: "name" })],
      index
    );

    expect(result.verdict).toBe("agrees_via_localized_global_name");
    // Not a disagreement — but surfaced as its own bucket, not folded into
    // plain agreement where it would read as clean.
    expect(isDisagreement(result.verdict)).toBe(false);
  });

  it("keeps a localised preset out of the caveat bucket on hard evidence", () => {
    const index = buildPartnerIndex(
      context({
        userPartners: [partner({ id: "p-local", globalPartnerId: "g-1" })],
      })
    );

    const result = classifyRematch(
      stored({ partnerId: "p-local" }),
      [match({ partnerId: "p-local", confidence: 100, source: "iban" })],
      index
    );

    expect(result.verdict).toBe("agrees");
  });
});

describe("scoreStoredPartner", () => {
  const transaction: TransactionData = {
    id: "tx1",
    partner: "UBER TECHNOLOGIES",
    partnerIban: null,
    name: "UBER *TRIP",
    reference: null,
  };

  it("scores the stored partner even when it is outside the top 3", () => {
    const index = buildPartnerIndex(
      context({
        userPartners: [partner({ id: "p-stored", name: "Uber Technologies" })],
      })
    );

    const score = scoreStoredPartner(transaction, stored(), index);

    expect(score).not.toBeNull();
    expect(score).toBeGreaterThan(0);
  });

  it("returns null when the stored partner no longer exists", () => {
    const index = buildPartnerIndex(context());
    expect(scoreStoredPartner(transaction, stored(), index)).toBeNull();
  });
});

describe("readAssignedAt", () => {
  const entry = (type: string, iso: string) => ({
    type,
    ranAt: { toDate: () => new Date(iso) },
  });

  it("returns the latest partner_assigned timestamp", () => {
    const history = [
      entry("partner_assigned", "2026-07-01T10:00:00.000Z"),
      entry("partner_removed", "2026-08-01T10:00:00.000Z"),
      entry("partner_assigned", "2026-08-02T10:00:00.000Z"),
    ];

    expect(readAssignedAt(history)).toBe("2026-08-02T10:00:00.000Z");
  });

  it("returns null when no partner_assigned entry was recorded", () => {
    expect(readAssignedAt([entry("file_connected", "2026-08-01T10:00:00.000Z")])).toBeNull();
    expect(readAssignedAt(undefined)).toBeNull();
    expect(readAssignedAt("not-an-array")).toBeNull();
  });
});
