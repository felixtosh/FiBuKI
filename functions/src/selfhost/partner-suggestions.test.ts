/**
 * The list's Partner cell and the detail panel resolve a Transaction's stored
 * suggestions through one function, so a row never shows a suggestion the
 * panel does not (which made opening a row re-run matching and rewrite it).
 */

import { describe, it, expect } from "vitest";
import { createPartnerSuggestionResolver } from "../../../lib/partners/partner-suggestions";

const user = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, ...extra }) as never;
const global = (id: string) => ({ id, name: id }) as never;

describe("createPartnerSuggestionResolver", () => {
  it("drops a Partner the user removed from this Transaction by hand", () => {
    const resolve = createPartnerSuggestionResolver(
      [user("p-removed", { manualRemovals: [{ transactionId: "tx1" }] }), user("p-ok")],
      [],
    );
    const out = resolve({
      id: "tx1",
      partnerSuggestions: [
        { partnerId: "p-removed", partnerType: "user", confidence: 95 },
        { partnerId: "p-ok", partnerType: "user", confidence: 70 },
      ],
    } as never);
    expect(out.map((s) => s.partnerId)).toEqual(["p-ok"]);
  });

  it("drops a Global Partner the user already has a copy of", () => {
    const resolve = createPartnerSuggestionResolver([user("mine", { globalPartnerId: "g1" })], [global("g1"), global("g2")]);
    const out = resolve({
      id: "tx1",
      partnerSuggestions: [
        { partnerId: "g1", partnerType: "global", confidence: 90 },
        { partnerId: "g2", partnerType: "global", confidence: 60 },
      ],
    } as never);
    expect(out.map((s) => s.partnerId)).toEqual(["g2"]);
  });

  it("orders by confidence, not by stored order, and skips unknown or repeated Partners", () => {
    const resolve = createPartnerSuggestionResolver([user("a"), user("b")], []);
    const out = resolve({
      id: "tx1",
      partnerSuggestions: [
        { partnerId: "a", partnerType: "user", confidence: 40 },
        { partnerId: "gone", partnerType: "user", confidence: 99 },
        { partnerId: "b", partnerType: "user", confidence: 80 },
        { partnerId: "a", partnerType: "user", confidence: 90 },
      ],
    } as never);
    expect(out.map((s) => [s.partnerId, s.confidence])).toEqual([
      ["b", 80],
      ["a", 40],
    ]);
  });
});
