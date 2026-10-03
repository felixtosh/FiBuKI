import { describe, it, expect } from "vitest";
import { matchCorrectionLink, type LinkMatchCandidate, type LinkMatchCorrection } from "./linkMatcher";

const credit: LinkMatchCorrection = {
  id: "f-credit",
  userId: "u",
  partnerId: "p-amazon",
  referencedInvoiceNumber: "DE-5ABC 1234",
  amount: -3000,
  date: "2026-02-10",
};

const file = (id: string, over: Partial<LinkMatchCandidate> = {}): LinkMatchCandidate => ({
  id,
  userId: "u",
  partnerId: "p-amazon",
  invoiceNumber: null,
  amount: 12000,
  date: "2026-01-05",
  ...over,
});

describe("matchCorrectionLink", () => {
  it("links on the referenced number within the Partner, ignoring spacing and case", () => {
    expect(matchCorrectionLink(credit, [file("f-a"), file("f-b", { invoiceNumber: "de5abc1234" })])).toEqual({
      kind: "link",
      fileId: "f-b",
    });
  });

  it("never links on a number matching another Partner's File", () => {
    const r = matchCorrectionLink(credit, [file("f-other", { partnerId: "p-shop", invoiceNumber: "DE5ABC1234" })]);
    expect(r).toEqual({ kind: "none" });
  });

  it("suggests by Partner and amount when no number matches: equal amount first, then the latest date", () => {
    const r = matchCorrectionLink({ ...credit, referencedInvoiceNumber: null }, [
      file("f-old", { date: "2025-12-01" }),
      file("f-equal", { amount: 3000, date: "2025-11-01" }),
      file("f-recent", { date: "2026-02-01" }),
      file("f-small", { amount: 1000 }),
      file("f-after", { date: "2026-03-01" }),
    ]);
    expect(r).toEqual({ kind: "suggestions", fileIds: ["f-equal", "f-recent", "f-old"] });
  });

  it("offers nothing without a candidate, or without a Partner", () => {
    expect(matchCorrectionLink(credit, [])).toEqual({ kind: "none" });
    expect(matchCorrectionLink({ ...credit, partnerId: null }, [file("f-b", { invoiceNumber: "DE5ABC1234" })])).toEqual({
      kind: "none",
    });
  });

  it("never returns another user's File, a correction document, or one a person declined", () => {
    const r = matchCorrectionLink({ ...credit, declinedFileIds: ["f-declined"] }, [
      file("f-theirs", { userId: "someone-else", invoiceNumber: "DE5ABC1234" }),
      file("f-credit-2", { isCorrection: true, invoiceNumber: "DE5ABC1234" }),
      file("f-declined", { invoiceNumber: "DE5ABC1234" }),
    ]);
    expect(r).toEqual({ kind: "none" });
  });
});
