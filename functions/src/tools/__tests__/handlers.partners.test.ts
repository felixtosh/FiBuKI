/**
 * Tool handler tests: partners, no-receipt categories and billing cycles.
 *
 * One of four files split from the former handlers.test.ts by area; shared
 * mocks and setup live in handlers-harness.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { store, createTestTransaction, createTestPartner } from "../../test/setup";
import { userId, otherUserId } from "./handlers-harness";

// vi.mock is hoisted per file, so the factories are imported inside it.
const extraction = vi.hoisted(() => ({ runExtraction: vi.fn() }));
vi.mock("firebase-admin/firestore", async () => (await import("./handlers-harness")).firestoreMock());
vi.mock("../../extraction/extractionCore", async () =>
  (await import("./handlers-harness")).extractionCoreMock(extraction),
);
vi.mock("firebase-functions/params", async () => (await import("./handlers-harness")).paramsMock());

// Import handlers after mocking
const handlers = await import("../handlers");

describe("Tool Registry Handlers: Partners, categories and billing cycles", () => {
  beforeEach(() => {
    store.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("listPartners - bounded read and paging (#116)", () => {
    // Seed n partners with sortable names, so page order is the name order.
    const seedPartners = (n: number, nameFor: (i: number) => string = (i) => `Partner ${String(i).padStart(3, "0")}`) => {
      for (let i = 0; i < n; i++) {
        store.setDoc("partners", `p-${String(i).padStart(3, "0")}`, createTestPartner({
          userId,
          name: nameFor(i),
          isActive: true,
        }));
      }
    };

    it("asks Firestore for one page, not for the whole collection", async () => {
      // The read used to be every active partner of the account, sliced to
      // 100 afterwards. The rows returned look the same either way, so the
      // assertion is on what the query carried.
      seedPartners(120);

      const result = await handlers.listPartners(userId, { limit: 10 });

      expect(result.count).toBe(10);
      expect(store.queries.filter((q) => q.collection === "partners")).toEqual([
        { collection: "partners", limit: 10, cursor: undefined },
      ]);
    });

    it("overfetches rather than truncating when a search has to filter in memory", async () => {
      // The search is a substring match Firestore cannot push down, so the
      // page still has to be filled from a wider read — bounded, not unbounded.
      seedPartners(120);

      await handlers.listPartners(userId, { search: "partner", limit: 10 });

      expect(store.queries.filter((q) => q.collection === "partners")).toEqual([
        { collection: "partners", limit: 50, cursor: undefined },
      ]);
    });

    it("honours a limit above the old ceiling of 100", async () => {
      seedPartners(150);

      const result = await handlers.listPartners(userId, { limit: 200 });

      expect(result.count).toBe(150);
    });

    it("caps the page at 500, and says there is more", async () => {
      seedPartners(600);

      const result = await handlers.listPartners(userId, { limit: 10_000 });

      expect(result.count).toBe(500);
      expect(result.nextCursor).not.toBeNull();
    });

    it("reaches partners past the old hard cap of 100", async () => {
      // Before the cursor there was no way to ask for the 101st name.
      seedPartners(250);

      const seen: string[] = [];
      let cursor: string | null | undefined = undefined;
      let guard = 0;

      do {
        const page: Awaited<ReturnType<typeof handlers.listPartners>> = await handlers.listPartners(userId, {
          limit: 50,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...page.partners.map((p) => p.id as string));
        cursor = page.nextCursor;
      } while (cursor && ++guard < 20);

      expect(seen).toHaveLength(250);
      expect(new Set(seen).size).toBe(250);
      expect(seen).toContain("p-249");
    });

    it("keeps search results whole across a page the filter empties", async () => {
      // 60 partners the search cannot match sit in front of 3 that do, with a
      // page of 5 -> a scan window of 25, so the first pages match nothing and
      // must still hand back a cursor.
      seedPartners(63, (i) => (i < 60 ? `Partner ${String(i).padStart(3, "0")}` : `Zebra ${i}`));

      const seen: string[] = [];
      let cursor: string | null | undefined = undefined;
      let guard = 0;

      do {
        const page: Awaited<ReturnType<typeof handlers.listPartners>> = await handlers.listPartners(userId, {
          search: "zebra",
          limit: 5,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...page.partners.map((p) => p.name as string));
        cursor = page.nextCursor;
      } while (cursor && ++guard < 30);

      expect(seen.sort()).toEqual(["Zebra 60", "Zebra 61", "Zebra 62"]);
    });

    it("leaves another user's partners out of the page and its cursor", async () => {
      seedPartners(3);
      store.setDoc("partners", "p-other", createTestPartner({
        userId: otherUserId,
        name: "Aaa Other",
        isActive: true,
      }));

      const result = await handlers.listPartners(userId, { cursor: "p-other" });

      expect(result.count).toBe(3);
      expect(result.partners.every((p) => (p.name as string).startsWith("Partner"))).toBe(true);
    });

    it("skips inactive partners", async () => {
      seedPartners(2);
      store.setDoc("partners", "p-off", createTestPartner({ userId, name: "Partner off", isActive: false }));

      const result = await handlers.listPartners(userId, {});

      expect(result.count).toBe(2);
    });
  });

  describe("listNoReceiptCategories", () => {
    it("should return active categories for user", async () => {
      store.setDoc("noReceiptCategories", "cat-1", { userId, name: "Bank Fees", isActive: true });
      store.setDoc("noReceiptCategories", "cat-2", { userId, name: "Interest", isActive: true });
      store.setDoc("noReceiptCategories", "cat-3", { userId, name: "Inactive", isActive: false });

      const result = await handlers.listNoReceiptCategories(userId);

      expect(result).toHaveLength(2);
    });
  });

  describe("assignNoReceiptCategory", () => {
    it("should assign category to transaction", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, isComplete: false }));
      store.setDoc("noReceiptCategories", "cat-1", {
        userId,
        name: "Bank Fees",
        templateId: "template-1",
        isActive: true,
        transactionCount: 0,
      });

      const result = await handlers.assignNoReceiptCategory(userId, {
        transactionId: "tx-1",
        categoryId: "cat-1",
      });

      expect(result.success).toBe(true);
      expect(result.categoryName).toBe("Bank Fees");

      const tx = store.getDoc("transactions", "tx-1");
      expect(tx?.noReceiptCategoryId).toBe("cat-1");
      expect(tx?.isComplete).toBe(true);
    });

    it("should throw error for non-existent category", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId }));

      await expect(
        handlers.assignNoReceiptCategory(userId, { transactionId: "tx-1", categoryId: "non-existent" })
      ).rejects.toThrow("Category non-existent not found or access denied");
    });
  });

  describe("removeNoReceiptCategory", () => {
    it("should remove category from transaction", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({
        userId,
        noReceiptCategoryId: "cat-1",
        isComplete: true,
        fileIds: [],
      }));
      store.setDoc("noReceiptCategories", "cat-1", {
        userId,
        name: "Bank Fees",
        transactionCount: 1,
      });

      const result = await handlers.removeNoReceiptCategory(userId, "tx-1");

      expect(result.success).toBe(true);
      expect(result.isComplete).toBe(false);

      const tx = store.getDoc("transactions", "tx-1");
      expect(tx?.noReceiptCategoryId).toBe(null);
    });

    it("should keep isComplete true if transaction has files", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({
        userId,
        noReceiptCategoryId: "cat-1",
        isComplete: true,
        fileIds: ["f-1"],
      }));
      store.setDoc("noReceiptCategories", "cat-1", { userId, transactionCount: 1 });

      const result = await handlers.removeNoReceiptCategory(userId, "tx-1");

      expect(result.isComplete).toBe(true);
    });

    it("should throw error if no category assigned", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, noReceiptCategoryId: null }));

      await expect(handlers.removeNoReceiptCategory(userId, "tx-1")).rejects.toThrow(
        "Transaction has no category assigned"
      );
    });
  });

  describe("billing cycle over the MCP", () => {
    /**
     * A partner's stored cycle in the shape `learnBillingCycle` writes it:
     * one entry per recurrence in each half, plus the resolved effective view.
     */
    function learnedBillingCycle(overrides: Record<string, unknown> = {}) {
      const learned = {
        frequencyDays: 30,
        frequencyConfidence: 80,
        typicalDayOfMonth: 5,
        dayVariance: 2,
        sampleSize: 6,
        learnedAt: new Date("2026-07-05T00:00:00Z"),
        ...overrides,
      };
      const { sampleSize, learnedAt, ...effective } = learned;
      return { learned: [learned], effective: [{ source: "learned", ...effective }] };
    }

    function charge(overrides: Record<string, unknown> = {}) {
      return createTestTransaction({
        userId,
        partnerId: "partner-1",
        amount: -3825,
        currency: "EUR",
        ...overrides,
      });
    }

    describe("get_partner / list_partners", () => {
      it("returns the effective cycle and both halves it was resolved from", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({
          userId,
          name: "Anthropic",
          billingCycle: learnedBillingCycle(),
        }));

        const partner = await handlers.getPartner(userId, "partner-1") as {
          billingCycle: {
            effective: Array<{ source: string; frequencyDays: number }>;
            learned: Array<{ sampleSize: number; learnedAt: string }>;
            declared: unknown[];
          };
        };

        expect(partner.billingCycle.effective).toEqual([
          expect.objectContaining({ source: "learned", frequencyDays: 30, typicalDayOfMonth: 5 }),
        ]);
        expect(partner.billingCycle.learned[0].sampleSize).toBe(6);
        // An instant, not a calendar day — a Timestamp would not survive JSON.
        expect(partner.billingCycle.learned[0].learnedAt).toBe("2026-07-05T00:00:00.000Z");
        expect(partner.billingCycle.declared).toEqual([]);
      });

      it("carries the cycle on list_partners, so no second call per partner is needed", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({
          userId,
          name: "Notion",
          billingCycle: learnedBillingCycle({ frequencyDays: 365 }),
        }));
        store.setDoc("partners", "partner-2", createTestPartner({ userId, name: "Rewe" }));

        const { partners: list } = await handlers.listPartners(userId, {}) as {
          partners: Array<{
            name: string;
            billingCycle: { effective: Array<{ frequencyDays: number }> } | null;
          }>;
        };

        expect(list[0].billingCycle!.effective[0].frequencyDays).toBe(365);
        // A partner that does not bill on a schedule reads as null, not as an
        // empty hull the caller has to unpack.
        expect(list[1].billingCycle).toBeNull();
      });
    });

    describe("set_partner_billing_cycle", () => {
      it("declares a cycle on a partner with no history behind it", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({ userId, name: "Canva" }));

        const result = await handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: { cadence: "monthly" },
        }) as { billingCycle: { effective: Array<Record<string, unknown>> } };

        expect(result.billingCycle.effective).toEqual([
          { source: "declared", frequencyDays: 30, documentExpectation: "invoice" },
        ]);
        const stored = store.getDoc("partners", "partner-1")!.billingCycle as {
          declared: Array<{ frequencyDays: number }>;
          learned?: unknown;
        };
        expect(stored.declared[0].frequencyDays).toBe(30);
        expect(stored.learned).toBeUndefined();
      });

      it("lets the declaration win over the learned cycle and keeps the learned half visible", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({
          userId,
          name: "Anthropic",
          billingCycle: learnedBillingCycle(),
        }));

        const result = await handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: { cadence: "weekly", documentExpectation: "nothing" },
        }) as {
          billingCycle: {
            effective: Array<{ source: string; frequencyDays: number; documentExpectation: string }>;
            learned: Array<{ frequencyDays: number }>;
            declared: Array<{ frequencyDays: number }>;
          };
        };

        expect(result.billingCycle.effective[0]).toMatchObject({
          source: "declared",
          frequencyDays: 7,
          documentExpectation: "nothing",
          // The declaration inherits what was actually observed.
          typicalDayOfMonth: 5,
        });
        expect(result.billingCycle.learned[0].frequencyDays).toBe(30);
        expect(result.billingCycle.declared[0].frequencyDays).toBe(7);
      });

      it("takes an interval with no name, and an expected amount band in the billed currency", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({ userId, name: "OpenAI" }));

        const result = await handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: {
            frequencyDays: 14,
            expectedAmountMin: 1900,
            expectedAmountMax: 2100,
            currency: "usd",
          },
        }) as { billingCycle: { declared: Array<Record<string, unknown>> } };

        expect(result.billingCycle.declared[0]).toEqual({
          frequencyDays: 14,
          // Nominal amount of the band, derived from the range it was given as.
          amountBand: 2000,
          expectedAmountMin: 1900,
          expectedAmountMax: 2100,
          currency: "USD",
          documentExpectation: "invoice",
        });
      });

      it("declares one recurrence per amount band", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({ userId, name: "Anthropic" }));

        const result = await handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: [
            { cadence: "weekly", amountBand: 3825 },
            { cadence: "monthly", amountBand: 9000 },
          ],
        }) as { billingCycle: { effective: Array<{ amountBand: number; frequencyDays: number }> } };

        expect(result.billingCycle.effective.map((e) => [e.amountBand, e.frequencyDays])).toEqual([
          [3825, 7],
          [9000, 30],
        ]);
      });

      it("clears the declaration on null and falls back to the learned cycle", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({
          userId,
          name: "Anthropic",
          billingCycle: learnedBillingCycle(),
        }));
        await handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: { cadence: "weekly" },
        });

        const cleared = await handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: null,
        }) as {
          billingCycle: {
            effective: Array<{ source: string; frequencyDays: number }>;
            declared: unknown[];
            learned: Array<{ frequencyDays: number }>;
          };
        };

        expect(cleared.billingCycle.declared).toEqual([]);
        expect(cleared.billingCycle.effective[0]).toMatchObject({ source: "learned", frequencyDays: 30 });
        expect(cleared.billingCycle.learned[0].frequencyDays).toBe(30);
        expect((store.getDoc("partners", "partner-1")!.billingCycle as { declared?: unknown }).declared)
          .toBeUndefined();
      });

      it("drops the field entirely when there is nothing learned to fall back to", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({ userId, name: "Vidio" }));
        await handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: { cadence: "monthly" },
        });

        const cleared = await handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: null,
        }) as { billingCycle: unknown };

        expect(cleared.billingCycle).toBeNull();
        expect(store.getDoc("partners", "partner-1")!.billingCycle).toBeUndefined();
      });

      it("refuses a declaration it cannot store", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({ userId }));
        store.setDoc("partners", "partner-2", createTestPartner({ userId: otherUserId }));

        await expect(handlers.setPartnerBillingCycle(userId, { declared: null }))
          .rejects.toThrow("partnerId is required");
        await expect(handlers.setPartnerBillingCycle(userId, { partnerId: "partner-2", declared: null }))
          .rejects.toThrow("Partner not found");
        await expect(handlers.setPartnerBillingCycle(userId, { partnerId: "partner-1" }))
          .rejects.toThrow("declared is required");
        await expect(handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: { cadence: "fortnightly" },
        })).rejects.toThrow("declared.cadence must be one of");
        await expect(handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: { typicalDayOfMonth: 3 },
        })).rejects.toThrow("declared needs either a cadence or frequencyDays");
        await expect(handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: { cadence: "monthly", frequencyDays: 31 },
        })).rejects.toThrow('declared.cadence "monthly" is 30 days');
        await expect(handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: [{ cadence: "weekly" }, { cadence: "monthly" }],
        })).rejects.toThrow("each declared recurrence needs its own amountBand");
      });
    });

    describe("list_recurring_partners", () => {
      it("returns the cycle, the last charge, the next expected window and coverage", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({
          userId,
          name: "Anthropic",
          website: "https://anthropic.com",
          billingCycle: learnedBillingCycle(),
        }));
        store.setDoc("transactions", "tx-1", charge({ date: new Date("2026-05-05"), fileIds: ["file-1"] }));
        store.setDoc("transactions", "tx-2", charge({ date: new Date("2026-06-05"), noReceiptCategoryId: "cat-1" }));
        store.setDoc("transactions", "tx-3", charge({ date: new Date("2026-07-05") }));

        const result = await handlers.listRecurringPartners(userId, {
          dateFrom: "2026-01-01",
          dateTo: "2026-07-31",
        }) as {
          partners: Array<{
            partnerId: string;
            name: string;
            website: string;
            billingCycle: { effective: Array<{ frequencyDays: number }> };
            lastCharge: Record<string, unknown>;
            nextExpected: Record<string, unknown>;
            coverage: Record<string, number>;
            recurrences: Array<Record<string, unknown>>;
          }>;
          nextCursor: string | null;
          count: number;
          dateFrom: string;
          dateTo: string;
        };

        expect(result.count).toBe(1);
        const partner = result.partners[0];
        expect(partner).toMatchObject({
          partnerId: "partner-1",
          name: "Anthropic",
          website: "https://anthropic.com",
        });
        expect(partner.billingCycle.effective[0].frequencyDays).toBe(30);
        expect(partner.lastCharge).toEqual({
          transactionId: "tx-3",
          date: "2026-07-05",
          amount: 3825,
          currency: "EUR",
          amountEur: 3825,
          hasFile: false,
          hasCategory: false,
          noReceiptCategoryId: null,
        });
        // 2026-07-05 plus the learned 30 days, plus or minus the day variance.
        expect(partner.nextExpected).toEqual({
          expectedAt: "2026-08-04",
          from: "2026-08-02",
          to: "2026-08-06",
          varianceDays: 2,
        });
        expect(partner.coverage).toEqual({ charges: 3, withFile: 1, withCategory: 1, missing: 1 });
        expect(partner.recurrences).toHaveLength(1);
        expect(partner.recurrences[0]).toMatchObject({
          amountBand: null,
          source: "learned",
          frequencyDays: 30,
          documentExpectation: "invoice",
          coverage: { charges: 3, missing: 1 },
        });
        expect(result).toMatchObject({
          nextCursor: null,
          dateFrom: "2026-01-01",
          dateTo: "2026-07-31",
        });
      });

      it("counts coverage inside the range, and still reports the last charge seen", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({
          userId,
          name: "Anthropic",
          billingCycle: learnedBillingCycle(),
        }));
        store.setDoc("transactions", "tx-1", charge({ date: new Date("2025-12-05") }));
        store.setDoc("transactions", "tx-2", charge({ date: new Date("2026-06-05") }));
        store.setDoc("transactions", "tx-3", charge({ date: new Date("2026-07-05") }));

        const result = await handlers.listRecurringPartners(userId, {
          dateFrom: "2026-06-01",
          dateTo: "2026-07-05",
        }) as { partners: Array<{ coverage: { charges: number }; lastCharge: { transactionId: string } }> };

        expect(result.partners[0].coverage.charges).toBe(2);
        // dateTo is inclusive: the charge booked on the last day counts.
        expect(result.partners[0].lastCharge.transactionId).toBe("tx-3");
      });

      it("reports the amount in the currency the bank says it charged, and in EUR", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({
          userId,
          name: "OpenAI",
          billingCycle: learnedBillingCycle(),
        }));
        store.setDoc("transactions", "tx-1", charge({
          date: new Date("2026-07-05"),
          amount: -1847,
          currency: "EUR",
          _original: {
            date: "05.07.2026",
            amount: "-18,47",
            rawRow: { "Original Amount": "20.00", "Original Currency": "USD", "Exchange Rate": "0.9235" },
          },
        }));

        const result = await handlers.listRecurringPartners(userId, {}) as {
          partners: Array<{ lastCharge: { amount: number; currency: string; amountEur: number } }>;
        };

        expect(result.partners[0].lastCharge).toMatchObject({
          amount: 2000,
          currency: "USD",
          amountEur: 1847,
        });
      });

      it("splits the recurrences of a partner that bills in more than one band", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({
          userId,
          name: "Anthropic",
          billingCycle: {
            learned: [
              { amountBand: 3825, frequencyDays: 7, frequencyConfidence: 90, sampleSize: 8, learnedAt: new Date("2026-07-06T00:00:00Z") },
              { amountBand: 9000, frequencyDays: 30, frequencyConfidence: 85, sampleSize: 4, learnedAt: new Date("2026-07-06T00:00:00Z") },
            ],
            effective: [
              { amountBand: 3825, source: "learned", frequencyDays: 7, frequencyConfidence: 90 },
              { amountBand: 9000, source: "learned", frequencyDays: 30, frequencyConfidence: 85 },
            ],
          },
        }));
        store.setDoc("transactions", "tx-1", charge({ date: new Date("2026-06-29"), amount: -3825 }));
        store.setDoc("transactions", "tx-2", charge({ date: new Date("2026-07-06"), amount: -3825, fileIds: ["file-1"] }));
        store.setDoc("transactions", "tx-3", charge({ date: new Date("2026-07-01"), amount: -9000 }));
        // A one-off payment to a recurring vendor: it belongs to no band.
        store.setDoc("transactions", "tx-4", charge({ date: new Date("2026-07-10"), amount: -50000 }));

        const result = await handlers.listRecurringPartners(userId, {
          dateFrom: "2026-06-01",
          dateTo: "2026-07-31",
        }) as {
          partners: Array<{
            lastCharge: { transactionId: string };
            coverage: { charges: number };
            recurrences: Array<{
              amountBand: number;
              frequencyDays: number;
              lastCharge: { transactionId: string };
              nextExpected: { expectedAt: string; varianceDays: number };
              coverage: { charges: number; withFile: number; missing: number };
            }>;
          }>;
        };

        // Counted for the partner, but it is nobody's recurrence.
        expect(result.partners[0].lastCharge.transactionId).toBe("tx-4");
        expect(result.partners[0].coverage.charges).toBe(4);

        const [weekly, monthly] = result.partners[0].recurrences;
        expect(weekly).toMatchObject({
          amountBand: 3825,
          frequencyDays: 7,
          lastCharge: { transactionId: "tx-2" },
          coverage: { charges: 2, withFile: 1, missing: 1 },
        });
        // A weekly recurrence carries no learned day variance; the window
        // falls back to the derivation's tolerance, clamped to half a period.
        expect(weekly.nextExpected).toMatchObject({ expectedAt: "2026-07-13", varianceDays: 3 });
        expect(monthly).toMatchObject({
          amountBand: 9000,
          frequencyDays: 30,
          lastCharge: { transactionId: "tx-3" },
          coverage: { charges: 1, withFile: 0, missing: 1 },
        });
      });

      it("never reports a missing document for a recurrence that produces none", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({ userId, name: "SVS" }));
        await handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: { cadence: "quarterly", documentExpectation: "nothing" },
        });
        store.setDoc("transactions", "tx-1", charge({ date: new Date("2026-07-05") }));

        const result = await handlers.listRecurringPartners(userId, {
          dateFrom: "2026-01-01",
          dateTo: "2026-12-31",
        }) as { partners: Array<{ coverage: { charges: number; missing: number } }> };

        expect(result.partners[0].coverage).toMatchObject({ charges: 1, missing: 0 });
      });

      it("skips partners with no cycle and partners of another user", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({
          userId,
          name: "Anthropic",
          billingCycle: learnedBillingCycle(),
        }));
        store.setDoc("partners", "partner-2", createTestPartner({ userId, name: "Rewe" }));
        store.setDoc("partners", "partner-3", createTestPartner({
          userId: otherUserId,
          name: "Netflix",
          billingCycle: learnedBillingCycle(),
        }));

        const result = await handlers.listRecurringPartners(userId, {}) as {
          partners: Array<{ partnerId: string }>;
        };

        expect(result.partners.map((p) => p.partnerId)).toEqual(["partner-1"]);
      });

      it("pages with a cursor", async () => {
        for (const [id, name] of [["partner-1", "Anthropic"], ["partner-2", "Notion"], ["partner-3", "Vidio"]]) {
          store.setDoc("partners", id, createTestPartner({
            userId,
            name,
            billingCycle: learnedBillingCycle(),
          }));
        }

        const first = await handlers.listRecurringPartners(userId, { limit: 2 }) as {
          partners: Array<{ name: string }>;
          nextCursor: string | null;
        };
        expect(first.partners.map((p) => p.name)).toEqual(["Anthropic", "Notion"]);
        expect(first.nextCursor).toBe("partner-2");

        const second = await handlers.listRecurringPartners(userId, {
          limit: 2,
          cursor: first.nextCursor!,
        }) as { partners: Array<{ name: string }>; nextCursor: string | null };
        expect(second.partners.map((p) => p.name)).toEqual(["Vidio"]);
        expect(second.nextCursor).toBeNull();
      });

      it("has no charge and no window for a partner declared recurring from day one", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({ userId, name: "Canva" }));
        await handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: { cadence: "monthly" },
        });

        const result = await handlers.listRecurringPartners(userId, {}) as {
          partners: Array<{ lastCharge: unknown; nextExpected: unknown; coverage: { charges: number } }>;
        };

        expect(result.partners[0]).toMatchObject({
          lastCharge: null,
          nextExpected: null,
          coverage: { charges: 0, withFile: 0, withCategory: 0, missing: 0 },
        });
      });

      it("rejects a malformed date boundary rather than widening the range", async () => {
        await expect(handlers.listRecurringPartners(userId, { dateFrom: "01.01.2026" }))
          .rejects.toThrow("dateFrom must be a calendar day");
        await expect(handlers.listRecurringPartners(userId, { dateTo: "2026-13-01" }))
          .rejects.toThrow("dateTo must be a calendar day");
      });
    });
  });
});
