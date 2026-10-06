/**
 * The Partner write tools (#213, #264): attaching a Partner to a File, editing
 * a Partner, and merging duplicates over the tool surface.
 *
 * Each tool wraps the operation the UI runs (`updateUserPartner`,
 * `mergeUserPartners`), so these tests assert what the tool adds or must keep:
 * the wholesale alias replacement and the Merge's refusals arriving intact
 * through `handleTool`. A Partner on a File is tested at its shared function
 * (`files/__tests__/filePartner.test.ts`, #627).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  store,
  createMockFirestore,
  createTestPartner,
  createTestTransaction,
  createTestFile,
} from "../../test/setup";

vi.mock("firebase-admin/firestore", () => {
  class MockTimestamp {
    constructor(private readonly date: Date) {}
    static fromDate(d: Date) {
      return new MockTimestamp(d);
    }
    static now() {
      return new MockTimestamp(new Date());
    }
    toDate() {
      return this.date;
    }
    valueOf() {
      return this.date.getTime();
    }
  }

  return {
    getFirestore: () => createMockFirestore(),
    FieldValue: {
      serverTimestamp: () => new Date(),
      arrayUnion: (...elements: unknown[]) => ({
        elements,
        constructor: { name: "ArrayUnionTransform" },
      }),
      arrayRemove: (...elements: unknown[]) => ({
        elements,
        constructor: { name: "ArrayRemoveTransform" },
      }),
      increment: (n: number) => n,
      delete: () => ({ constructor: { name: "DeleteTransform" } }),
    },
    Timestamp: MockTimestamp,
  };
});

vi.mock("../../utils/createCallable", () => ({
  createCallable: <TReq, TRes>(
    _config: { name: string },
    handler: (ctx: unknown, data: TReq) => Promise<TRes>
  ) => handler,
  HttpsError: class HttpsError extends Error {
    constructor(
      public code: string,
      message: string,
      public details?: unknown
    ) {
      super(message);
    }
  },
}));

const cancelWorkers = vi.hoisted(() => ({ cancelPartnerWorkersForFile: vi.fn() }));
vi.mock("../../utils/cancelWorkers", () => ({
  cancelPartnerWorkersForFile: (...args: unknown[]) => {
    cancelWorkers.cancelPartnerWorkersForFile(...args);
    return Promise.resolve({ cancelledRequests: 0, cancelledRuns: 0 });
  },
}));

vi.mock("../../extraction/extractionCore", () => ({ runExtraction: vi.fn() }));
// update_partner checks a VAT ID with VIES (#665); never the real register here.
const lookupVatId = vi.fn(async (vatId: string) => ({ vatId, viesValid: true, name: "VIES NAME" }));
vi.mock("../../ai/lookupCompany", () => ({
  lookupVatId: (vatId: string) => lookupVatId(vatId),
  VIES_NOT_VALID: "VAT ID not valid according to VIES",
}));
vi.mock("firebase-functions/params", () => ({
  defineSecret: (name: string) => ({ value: () => `test-${name}` }),
}));

const handlers = await import("../handlers");

const USER = "user-partner-tools";
const OTHER_USER = "someone-else";

type Doc = Record<string, unknown>;

function seedPartner(id: string, data: Doc = {}): void {
  store.setDoc("partners", id, createTestPartner({ userId: USER, ...data }));
}

function seedFile(id: string, data: Doc = {}): void {
  store.setDoc("files", id, createTestFile({ userId: USER, ...data }));
}

const doc = (collection: string, id: string) => store.getDoc(collection, id) as Doc;

describe("Partner write tools", () => {
  beforeEach(() => {
    store.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // #213: editing a Partner
  // ==========================================================================

  describe("update_partner", () => {
    it("replaces aliases wholesale, so one can be removed", async () => {
      seedPartner("p-1", {
        name: "AL&FA Taxi KG",
        aliases: ["AL&FA", "Agent Platform GmbH", "Alfa Taxi"],
      });

      const result = (await handlers.handleTool(USER, "update_partner", {
        partnerId: "p-1",
        aliases: ["AL&FA", "Alfa Taxi"],
      })) as Doc;

      expect(doc("partners", "p-1").aliases).toEqual(["AL&FA", "Alfa Taxi"]);
      expect(result.aliases).toEqual(["AL&FA", "Alfa Taxi"]);
      expect(result.name).toBe("AL&FA Taxi KG");
    });

    it("writes create_partner's field set through the Partners page's normalisation", async () => {
      seedPartner("p-1", { name: "Old", vatId: "ATU1", ibans: ["AT00 1"], website: null });

      const result = (await handlers.handleTool(USER, "update_partner", {
        partnerId: "p-1",
        name: "  New GmbH ",
        vatId: "atu 123 456 78",
        ibans: ["at61 1904 3002 3457 3201"],
        website: "Example.com/",
        country: "AT",
      })) as Doc;

      // VIES is asked about the normalised VAT ID; a name given wins over VIES's.
      expect(lookupVatId).toHaveBeenLastCalledWith("ATU12345678");
      expect(result.vatIdCheck).toEqual({ vatId: "ATU12345678", valid: true, name: "VIES NAME", error: null });
      expect(doc("partners", "p-1")).toMatchObject({
        name: "New GmbH",
        vatId: "ATU12345678",
        ibans: ["AT611904300234573201"],
        website: "https://example.com",
        country: "AT",
      });
    });

    it("leaves fields it was not given alone, and clears aliases on []", async () => {
      seedPartner("p-1", { name: "Keep", aliases: ["Gone"], vatId: "ATU12345678" });

      await handlers.handleTool(USER, "update_partner", { partnerId: "p-1", aliases: [] });

      expect(doc("partners", "p-1")).toMatchObject({
        name: "Keep",
        aliases: [],
        vatId: "ATU12345678",
      });
    });

    it("refuses an empty call, a non-array alias list, and fields outside its set", async () => {
      seedPartner("p-1", { name: "Keep", isMyCompany: false });

      await expect(
        handlers.handleTool(USER, "update_partner", { partnerId: "p-1" })
      ).rejects.toThrow(/Nothing to update/);
      await expect(
        handlers.handleTool(USER, "update_partner", { partnerId: "p-1", aliases: "Foo" })
      ).rejects.toThrow(/aliases must be an array/);

      await handlers.handleTool(USER, "update_partner", {
        partnerId: "p-1",
        name: "Keep",
        isMyCompany: true,
      });
      expect(doc("partners", "p-1").isMyCompany).toBe(false);
    });

    it("refuses another user's Partner and a Merged Partner", async () => {
      store.setDoc("partners", "p-theirs", createTestPartner({ userId: OTHER_USER }));
      seedPartner("p-old", { isActive: false, mergedInto: "p-new" });

      await expect(
        handlers.handleTool(USER, "update_partner", { partnerId: "p-theirs", name: "X" })
      ).rejects.toThrow("Partner not found");
      await expect(
        handlers.handleTool(USER, "update_partner", { partnerId: "p-old", name: "X" })
      ).rejects.toThrow(/merged into p-new/);
    });
  });

  // ==========================================================================
  // #264: Partner Merge
  // ==========================================================================

  describe("merge_partners", () => {
    function seedDuplicates(): void {
      seedPartner("survivor", { name: "Acme GmbH", aliases: [] });
      seedPartner("loser", { name: "ACME Handels" });
      store.setDoc(
        "transactions",
        "tx-1",
        createTestTransaction({ userId: USER, partnerId: "loser", partnerType: "user" })
      );
      seedFile("f-1", { partnerId: "loser", partnerType: "user" });
    }

    it("refuses without confirm: true and writes nothing", async () => {
      seedDuplicates();

      for (const confirm of [undefined, false, "true", 1]) {
        await expect(
          handlers.handleTool(USER, "merge_partners", {
            survivorId: "survivor",
            loserIds: ["loser"],
            confirm,
          })
        ).rejects.toThrow(/cannot be undone/);
      }
      expect(doc("partners", "loser").mergedInto).toBeUndefined();
      expect(doc("files", "f-1").partnerId).toBe("loser");
    });

    it("merges and reports what moved and what the survivor would now hit", async () => {
      seedDuplicates();

      const result = (await handlers.handleTool(USER, "merge_partners", {
        survivorId: "survivor",
        loserIds: ["loser"],
        confirm: true,
      })) as Doc;

      expect(result).toMatchObject({
        success: true,
        survivorId: "survivor",
        mergedPartnerIds: ["loser"],
        aliasesAdded: ["ACME Handels"],
        repointed: expect.objectContaining({ transactions: 1, files: 1, invoices: 0 }),
        rematchPreview: expect.objectContaining({ newlyMatchable: expect.any(Number) }),
      });
      expect(doc("transactions", "tx-1").partnerId).toBe("survivor");
      expect(doc("files", "f-1").partnerId).toBe("survivor");
    });

    it("refuses differing VAT IDs on confirm alone, and needs its own affirmation", async () => {
      seedPartner("survivor", { name: "Acme GmbH", vatId: "ATU11111111" });
      seedPartner("loser", { name: "Acme", vatId: "ATU22222222" });

      await expect(
        handlers.handleTool(USER, "merge_partners", {
          survivorId: "survivor",
          loserIds: ["loser"],
          confirm: true,
        })
      ).rejects.toThrow(/different VAT IDs/);
      await expect(
        handlers.handleTool(USER, "merge_partners", {
          survivorId: "survivor",
          loserIds: ["loser"],
          confirm: true,
          confirmVatIdConflict: "yes",
        })
      ).rejects.toThrow(/confirmVatIdConflict must be a boolean/);
      expect(doc("partners", "loser").mergedInto).toBeUndefined();

      const result = (await handlers.handleTool(USER, "merge_partners", {
        survivorId: "survivor",
        loserIds: ["loser"],
        confirm: true,
        confirmVatIdConflict: true,
      })) as Doc;
      expect(result.success).toBe(true);
    });

    it("refuses to merge into a Merged Partner", async () => {
      seedPartner("tombstone", { isActive: false, mergedInto: "elsewhere" });
      seedPartner("loser");

      await expect(
        handlers.handleTool(USER, "merge_partners", {
          survivorId: "tombstone",
          loserIds: ["loser"],
          confirm: true,
        })
      ).rejects.toThrow(/is a Merged Partner/);
    });

    it("keeps the Merge's refusal of a source's Partner as a loser", async () => {
      seedPartner("survivor");
      seedPartner("source-partner", { identitySourceField: "source:src-1" });
      store.setDoc("sources", "src-1", { userId: USER, name: "Giro" });

      await expect(
        handlers.handleTool(USER, "merge_partners", {
          survivorId: "survivor",
          loserIds: ["source-partner"],
          confirm: true,
        })
      ).rejects.toThrow(/Partner of source/);
    });

    it("reads a merged-away Partner back as itself, naming its survivor", async () => {
      seedDuplicates();
      await handlers.handleTool(USER, "merge_partners", {
        survivorId: "survivor",
        loserIds: ["loser"],
        confirm: true,
      });

      const read = (await handlers.handleTool(USER, "get_partner", { partnerId: "loser" })) as Doc;
      expect(read).toMatchObject({
        id: "loser",
        name: "ACME Handels",
        isActive: false,
        mergedInto: "survivor",
        survivor: { id: "survivor", name: "Acme GmbH" },
      });

      const live = (await handlers.handleTool(USER, "get_partner", { partnerId: "survivor" })) as Doc;
      expect(live.survivor).toBeUndefined();

      const { partners } = (await handlers.handleTool(USER, "list_partners", {})) as {
        partners: Array<{ id: string }>;
      };
      expect(partners.map((p) => p.id)).toEqual(["survivor"]);
    });
  });
});
