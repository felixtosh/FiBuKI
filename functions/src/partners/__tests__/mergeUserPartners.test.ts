/**
 * Partner Merge (#262)
 *
 * The merge rules are asserted through the operation itself, and the three
 * "afterwards" criteria that belong to a reader — absent from the Partner list,
 * not a match candidate, read back as itself — are asserted through the real
 * readers (`listPartners`, `loadPartnerMatchingContext`, `getPartner`) rather
 * than against a query this file writes, because those readers are what the
 * criteria are about.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  store,
  createMockFirestore,
  createTestPartner,
  createTestTransaction,
  createTestFile,
} from "../../test/setup";

// Mock firebase-admin/firestore: the readers under test take a Firestore handle
// at module scope, and Timestamp has to be a value the in-memory store compares.
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

// handlers.ts spends an AI call in one unrelated tool; the model boundary and
// the secret are mocked so the module can be imported for its partner readers.
vi.mock("../../extraction/extractionCore", () => ({ runExtraction: vi.fn() }));
vi.mock("firebase-functions/params", () => ({
  defineSecret: (name: string) => ({ value: () => `test-${name}` }),
}));

const { mergeUserPartnersInternal, mergeUserPartnersCallable, mergePartnerFields } =
  await import("../mergeUserPartners");
const handlers = await import("../../tools/handlers");
const { loadPartnerMatchingContext } = await import("../../matching/partnerMatchingShared");

const USER = "user-merge-262";
const OTHER_USER = "user-someone-else";

type Doc = Record<string, unknown>;

function db(): FirebaseFirestore.Firestore {
  return createMockFirestore() as unknown as FirebaseFirestore.Firestore;
}

function seedPartner(id: string, data: Doc = {}): void {
  store.setDoc("partners", id, createTestPartner({ userId: USER, ...data }));
}

function partnerDoc(id: string): Doc {
  return store.getDoc("partners", id) as Doc;
}

function merge(
  survivorId: string,
  loserIds: string[],
  options: { confirmVatIdConflict?: boolean } = {}
) {
  return mergeUserPartnersInternal(db(), USER, { survivorId, loserIds, ...options });
}

function ts(date: string) {
  return { toDate: () => new Date(date) };
}

describe("Partner Merge", () => {
  beforeEach(() => {
    store.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // One operation, several losers, every kind of reference
  // ==========================================================================

  describe("what it repoints", () => {
    /**
     * The four kinds the criteria name, on one merge: a Transaction, a File, an
     * issued Invoice and the identity entities. Two losers go in at once.
     */
    function seedAllFourKinds(): void {
      seedPartner("survivor", { name: "Acme GmbH" });
      seedPartner("loser-a", { name: "Acme Gmbh" });
      seedPartner("loser-b", { name: "ACME Handels" });

      store.setDoc(
        "transactions",
        "tx-1",
        createTestTransaction({
          userId: USER,
          partnerId: "loser-a",
          partnerType: "user",
          partnerMatchedBy: "manual",
          partnerMatchConfidence: 100,
        })
      );

      store.setDoc(
        "files",
        "file-1",
        createTestFile({ userId: USER, partnerId: "loser-b", partnerType: "user" })
      );

      store.setDoc("invoices", "inv-1", {
        userId: USER,
        status: "issued",
        number: "2026-0007",
        recipient: {
          partnerId: "loser-a",
          partnerType: "user",
          name: "Acme Gmbh",
          vatId: "ATU11111111",
          address: { street: "Hauptstraße 1", city: "Wien", postalCode: "1010", country: "AT" },
        },
      });

      store.setDoc(`users/${USER}/settings`, "userData", {
        personalEntity: { id: "pe", type: "person", name: "Felix", partnerId: "loser-b" },
        companies: [
          { id: "c1", type: "company", name: "Felix GmbH", partnerId: "loser-a" },
          { id: "c2", type: "company", name: "Other GmbH", partnerId: "untouched" },
        ],
        markedAsMe: ["loser-a", "somebody-else"],
        identityPartnerIds: { name: "loser-b" },
      });

      // A Notification naming the loser, in the per-user subcollection the app
      // actually writes them to. It records an event that already happened, so
      // a merge must leave it exactly as it is.
      store.setDoc(`users/${USER}/notifications`, "notif-1", {
        userId: USER,
        type: "partner_matched",
        partnerId: "loser-a",
      });
    }

    it("completes as one operation and repoints all four kinds onto the survivor", async () => {
      seedAllFourKinds();

      const result = await merge("survivor", ["loser-a", "loser-b"]);

      expect(result.success).toBe(true);
      expect(result.survivorId).toBe("survivor");
      expect(result.mergedPartnerIds).toEqual(["loser-a", "loser-b"]);
      expect(result.repointed.transactions).toBe(1);
      expect(result.repointed.files).toBe(1);
      expect(result.repointed.invoices).toBe(1);
      // personalEntity, one company, one markedAsMe entry, one legacy pointer.
      expect(result.repointed.identityReferences).toBe(4);

      const tx = store.getDoc("transactions", "tx-1")!;
      expect(tx.partnerId).toBe("survivor");
      expect(tx.partnerType).toBe("user");
      // How it was matched is unchanged: a manual assignment to a duplicate is
      // still a manual assignment.
      expect(tx.partnerMatchedBy).toBe("manual");

      expect(store.getDoc("files", "file-1")!.partnerId).toBe("survivor");
    });

    it("moves an issued invoice's pointer and nothing it froze at issue time", async () => {
      seedAllFourKinds();

      await merge("survivor", ["loser-a", "loser-b"]);

      const recipient = (store.getDoc("invoices", "inv-1")!.recipient as Doc);
      expect(recipient.partnerId).toBe("survivor");
      expect(recipient.partnerType).toBe("user");
      expect(recipient.name).toBe("Acme Gmbh");
      expect(recipient.vatId).toBe("ATU11111111");
      expect(recipient.address).toEqual({
        street: "Hauptstraße 1",
        city: "Wien",
        postalCode: "1010",
        country: "AT",
      });
    });

    it("repoints the identity entities and leaves the ones naming nobody merged", async () => {
      seedAllFourKinds();

      await merge("survivor", ["loser-a", "loser-b"]);

      const userData = store.getDoc(`users/${USER}/settings`, "userData")!;
      expect((userData.personalEntity as Doc).partnerId).toBe("survivor");
      expect((userData.personalEntity as Doc).name).toBe("Felix");

      const companies = userData.companies as Doc[];
      expect(companies[0].partnerId).toBe("survivor");
      expect(companies[1].partnerId).toBe("untouched");

      expect(userData.markedAsMe).toEqual(["survivor", "somebody-else"]);
      expect((userData.identityPartnerIds as Doc).name).toBe("survivor");
    });

    it("leaves notifications alone", async () => {
      seedAllFourKinds();

      await merge("survivor", ["loser-a", "loser-b"]);

      expect(
        store.getDoc(`users/${USER}/notifications`, "notif-1")!.partnerId
      ).toBe("loser-a");
    });

    /** A queue item as the scheduler writes it: no partnerType, no updatedAt. */
    function seedQueueItem(id: string, data: Doc): void {
      store.setDoc("invoiceFetchQueue", id, {
        userId: USER,
        invoiceSourceId: "src-1",
        url: "https://acme.at/billing",
        domain: "acme.at",
        status: "pending",
        filesDownloaded: 0,
        fileIds: [],
        retryCount: 0,
        maxRetries: 3,
        ...data,
      });
    }

    it("repoints queued invoice-fetch work, at every status (#307)", async () => {
      seedAllFourKinds();
      seedQueueItem("q-pending", { partnerId: "loser-a" });
      seedQueueItem("q-done", {
        partnerId: "loser-b",
        status: "completed",
        filesDownloaded: 2,
        fileIds: ["file-a", "file-b"],
      });
      seedQueueItem("q-elsewhere", { partnerId: "untouched" });
      seedQueueItem("q-theirs", { userId: OTHER_USER, partnerId: "loser-a" });

      const result = await merge("survivor", ["loser-a", "loser-b"]);

      expect(result.repointed.invoiceFetchQueue).toBe(2);
      expect(store.getDoc("invoiceFetchQueue", "q-pending")!.partnerId).toBe("survivor");

      const done = store.getDoc("invoiceFetchQueue", "q-done")!;
      expect(done.partnerId).toBe("survivor");
      // What the fetch already did stays as it was, and the item gains no
      // field the queue's own schema does not have.
      expect(done.fileIds).toEqual(["file-a", "file-b"]);
      expect(done.invoiceSourceId).toBe("src-1");
      expect(done.partnerType).toBeUndefined();
      expect(done.updatedAt).toBeUndefined();

      expect(store.getDoc("invoiceFetchQueue", "q-elsewhere")!.partnerId).toBe("untouched");
      expect(store.getDoc("invoiceFetchQueue", "q-theirs")!.partnerId).toBe("loser-a");
    });

    it("repoints nothing belonging to another user", async () => {
      seedAllFourKinds();
      store.setDoc(
        "transactions",
        "tx-other",
        createTestTransaction({ userId: OTHER_USER, partnerId: "loser-a" })
      );

      const result = await merge("survivor", ["loser-a", "loser-b"]);

      expect(result.repointed.transactions).toBe(1);
      expect(store.getDoc("transactions", "tx-other")!.partnerId).toBe("loser-a");
    });
  });

  // ==========================================================================
  // The Merged Partner
  // ==========================================================================

  describe("the Merged Partner each loser becomes", () => {
    beforeEach(() => {
      seedPartner("survivor", { name: "Acme GmbH" });
      seedPartner("loser", { name: "Acme Gmbh" });
    });

    it("is inactive and names its survivor", async () => {
      await merge("survivor", ["loser"]);

      const tombstone = partnerDoc("loser");
      expect(tombstone.isActive).toBe(false);
      expect(tombstone.mergedInto).toBe("survivor");
      expect(tombstone.mergedAt).toBeTruthy();
    });

    it("is absent from the Partner list", async () => {
      await merge("survivor", ["loser"]);

      const { partners } = await handlers.listPartners(USER, {});
      expect(partners.map((p) => p.id)).toEqual(["survivor"]);
    });

    it("is not a match candidate", async () => {
      await merge("survivor", ["loser"]);

      const context = await loadPartnerMatchingContext(USER);
      expect(context.userPartners.map((p) => p.id)).toEqual(["survivor"]);
    });

    it("reads back as itself with its survivor named, never as the survivor", async () => {
      await merge("survivor", ["loser"]);

      const read = (await handlers.getPartner(USER, "loser")) as Doc;
      expect(read.id).toBe("loser");
      expect(read.name).toBe("Acme Gmbh");
      expect(read.mergedInto).toBe("survivor");
    });
  });

  // ==========================================================================
  // What the survivor gains
  // ==========================================================================

  describe("what the survivor gains", () => {
    it("takes each loser's name as an alias", async () => {
      seedPartner("survivor", { name: "Acme GmbH", aliases: ["Acme Wien"] });
      seedPartner("loser-a", { name: "Acme Gesellschaft mbH", aliases: ["Acme Handels"] });
      seedPartner("loser-b", { name: "ACME" });

      const result = await merge("survivor", ["loser-a", "loser-b"]);

      expect(partnerDoc("survivor").aliases).toEqual([
        "Acme Wien",
        "Acme Gesellschaft mbH",
        "Acme Handels",
        "ACME",
      ]);
      expect(result.aliasesAdded).toEqual([
        "Acme Gesellschaft mbH",
        "Acme Handels",
        "ACME",
      ]);
    });

    it("does not add an alias that only repeats the survivor's own name", async () => {
      seedPartner("survivor", { name: "Acme GmbH" });
      seedPartner("loser", { name: "acme gmbh", aliases: ["ACME GMBH"] });

      const result = await merge("survivor", ["loser"]);

      expect(partnerDoc("survivor").aliases ?? []).toEqual([]);
      expect(result.aliasesAdded).toEqual([]);
    });

    it("fills a survivor whose fields are entirely empty from its loser", async () => {
      seedPartner("survivor", { name: "Acme" });
      seedPartner("loser", {
        name: "Acme GmbH",
        globalPartnerId: "global-acme",
        vatId: "ATU12345678",
        viesVerified: true,
        viesVerifiedAt: ts("2026-01-02"),
        country: "AT",
        address: { street: "Hauptstraße 1", country: "AT" },
        website: "https://acme.at",
        notes: "the good one",
        defaultCategoryId: "cat-1",
        ibans: ["AT611904300234573201"],
        emailDomains: ["acme.at"],
        learnedPatterns: [{ pattern: "*acme*", confidence: 92, createdAt: ts("2026-01-01"), sourceTransactionIds: [] }],
        resolutionPreference: { typical: "file_required" },
      });

      await merge("survivor", ["loser"]);

      const survivor = partnerDoc("survivor");
      expect(survivor.name).toBe("Acme");
      expect(survivor.globalPartnerId).toBe("global-acme");
      expect(survivor.vatId).toBe("ATU12345678");
      expect(survivor.viesVerified).toBe(true);
      expect(survivor.viesVerifiedAt).toBeTruthy();
      expect(survivor.country).toBe("AT");
      expect(survivor.address).toEqual({ street: "Hauptstraße 1", country: "AT" });
      expect(survivor.website).toBe("https://acme.at");
      expect(survivor.notes).toBe("the good one");
      expect(survivor.defaultCategoryId).toBe("cat-1");
      expect(survivor.ibans).toEqual(["AT611904300234573201"]);
      expect(survivor.emailDomains).toEqual(["acme.at"]);
      expect((survivor.learnedPatterns as Doc[])[0].pattern).toBe("*acme*");
      expect(survivor.resolutionPreference).toEqual({ typical: "file_required" });
      // Nothing on the tombstone conflicted: the survivor held none of it.
      expect(partnerDoc("loser").mergeConflicts).toBeUndefined();
    });

    it("keeps its own single values and records the loser's on the Merged Partner", async () => {
      seedPartner("survivor", {
        name: "Acme GmbH",
        country: "AT",
        website: "https://acme.at",
        globalPartnerId: "global-acme",
      });
      seedPartner("loser", {
        name: "Acme Gmbh",
        country: "DE",
        website: "https://acme.de",
        globalPartnerId: "global-other",
        notes: "only the loser had this",
      });

      const result = await merge("survivor", ["loser"]);

      const survivor = partnerDoc("survivor");
      expect(survivor.country).toBe("AT");
      expect(survivor.website).toBe("https://acme.at");
      expect(survivor.globalPartnerId).toBe("global-acme");
      // An empty one is still filled from the loser.
      expect(survivor.notes).toBe("only the loser had this");

      const conflicts = partnerDoc("loser").mergeConflicts as Doc[];
      expect(conflicts).toEqual([
        { field: "globalPartnerId", value: "global-other", survivorValue: "global-acme" },
        { field: "country", value: "DE", survivorValue: "AT" },
        { field: "website", value: "https://acme.de", survivorValue: "https://acme.at" },
      ]);
      expect(result.conflicts).toEqual([
        { partnerId: "loser", fields: ["globalPartnerId", "country", "website"] },
      ]);
    });

    it("moves a VAT ID together with the VIES verification that proved it", async () => {
      seedPartner("survivor", { name: "Acme GmbH" });
      seedPartner("loser", {
        name: "Acme Gmbh",
        vatId: "ATU12345678",
        viesVerified: true,
        viesVerifiedAt: ts("2026-01-02"),
      });

      await merge("survivor", ["loser"]);

      const survivor = partnerDoc("survivor");
      expect(survivor.vatId).toBe("ATU12345678");
      expect(survivor.viesVerified).toBe(true);
    });

    it("does not take a VIES verification for a VAT ID it did not take", async () => {
      seedPartner("survivor", { name: "Acme GmbH", vatId: "ATU99999999" });
      seedPartner("loser", {
        name: "Acme Gmbh",
        vatId: "ATU12345678",
        viesVerified: true,
        viesVerifiedAt: ts("2026-01-02"),
      });

      await merge("survivor", ["loser"], { confirmVatIdConflict: true });

      const survivor = partnerDoc("survivor");
      expect(survivor.vatId).toBe("ATU99999999");
      expect(survivor.viesVerified).toBeUndefined();
      expect(survivor.viesVerifiedAt).toBeUndefined();
    });

    it("unions every identifying collection, negative signals included", async () => {
      seedPartner("survivor", {
        name: "Acme GmbH",
        ibans: ["AT611904300234573201"],
        emailDomains: ["acme.at"],
        learnedPatterns: [
          { pattern: "*acme*", confidence: 92, createdAt: ts("2026-01-01"), sourceTransactionIds: ["tx-s"] },
        ],
        manualRemovals: [
          { transactionId: "tx-veto-s", removedAt: ts("2026-01-01"), partner: "Acme", name: "x" },
        ],
        manualFileRemovals: [
          { fileId: "file-veto-s", removedAt: ts("2026-01-01"), extractedPartner: "Acme", fileName: "s.pdf" },
        ],
        fileSourcePatterns: [
          {
            sourceType: "gmail",
            pattern: "from:acme.at",
            confidence: 80,
            usageCount: 1,
            sourceTransactionIds: [],
            createdAt: ts("2026-01-01"),
            lastUsedAt: ts("2026-01-01"),
          },
        ],
        emailSearchPatterns: [
          {
            pattern: "from:acme.at invoice",
            integrationIds: ["gi-1"],
            confidence: 70,
            usageCount: 1,
            sourceTransactionIds: [],
            createdAt: ts("2026-01-01"),
            lastUsedAt: ts("2026-01-01"),
          },
        ],
        invoiceLinks: [
          { url: "https://acme.at/inv/1", discoveredAt: ts("2026-01-01"), emailMessageId: "m1", verified: false },
        ],
        browserRecipes: [
          {
            id: "r-s",
            startUrl: "https://acme.at/billing",
            domain: "acme.at",
            recordedActions: [],
            requiresAuth: true,
            useCount: 1,
            autoRun: false,
            createdAt: ts("2026-01-01"),
            updatedAt: ts("2026-01-01"),
          },
        ],
        categoryMatchRules: [
          {
            categoryId: "cat-private",
            categoryTemplateId: "private",
            patterns: ["*premium*"],
            confidence: 80,
            createdAt: ts("2026-01-01"),
            updatedAt: ts("2026-01-01"),
            sourceTransactionIds: [],
          },
        ],
        categoryManualRemovals: [
          {
            transactionId: "tx-cat-s",
            categoryId: "cat-private",
            removedAt: ts("2026-01-01"),
            partner: "Acme",
            name: "x",
            reference: null,
          },
        ],
      });
      seedPartner("loser", {
        name: "Acme Gmbh",
        // The survivor already knows this IBAN; only the new one is added.
        ibans: ["AT611904300234573201", "AT022050302101023600"],
        emailDomains: ["ACME.DE"],
        learnedPatterns: [
          { pattern: "*acme*handels*", confidence: 88, createdAt: ts("2026-02-01"), sourceTransactionIds: ["tx-l"] },
          // Same pattern the survivor already learned: the survivor's entry wins.
          { pattern: "*ACME*", confidence: 50, createdAt: ts("2026-02-01"), sourceTransactionIds: ["tx-l2"] },
        ],
        manualRemovals: [
          { transactionId: "tx-veto-l", removedAt: ts("2026-02-01"), partner: "Acme", name: "y" },
        ],
        manualFileRemovals: [
          { fileId: "file-veto-l", removedAt: ts("2026-02-01"), extractedPartner: "Acme", fileName: "l.pdf" },
        ],
        fileSourcePatterns: [
          {
            sourceType: "gmail",
            pattern: "from:acme.de",
            confidence: 60,
            usageCount: 1,
            sourceTransactionIds: [],
            createdAt: ts("2026-02-01"),
            lastUsedAt: ts("2026-02-01"),
          },
        ],
        emailSearchPatterns: [
          {
            pattern: "from:acme.de rechnung",
            integrationIds: ["gi-1"],
            confidence: 60,
            usageCount: 1,
            sourceTransactionIds: [],
            createdAt: ts("2026-02-01"),
            lastUsedAt: ts("2026-02-01"),
          },
        ],
        invoiceLinks: [
          { url: "https://acme.de/inv/2", discoveredAt: ts("2026-02-01"), emailMessageId: "m2", verified: false },
        ],
        browserRecipes: [
          {
            id: "r-l",
            startUrl: "https://acme.de/billing",
            domain: "acme.de",
            recordedActions: [],
            requiresAuth: true,
            useCount: 1,
            autoRun: false,
            createdAt: ts("2026-02-01"),
            updatedAt: ts("2026-02-01"),
          },
        ],
        categoryMatchRules: [
          {
            categoryId: "cat-office",
            categoryTemplateId: "office",
            patterns: ["*office*"],
            confidence: 75,
            createdAt: ts("2026-02-01"),
            updatedAt: ts("2026-02-01"),
            sourceTransactionIds: [],
          },
        ],
        categoryManualRemovals: [
          {
            transactionId: "tx-cat-l",
            categoryId: "cat-private",
            removedAt: ts("2026-02-01"),
            partner: "Acme",
            name: "y",
            reference: null,
          },
        ],
      });

      await merge("survivor", ["loser"]);

      const survivor = partnerDoc("survivor");
      expect(survivor.ibans).toEqual(["AT611904300234573201", "AT022050302101023600"]);
      expect(survivor.emailDomains).toEqual(["acme.at", "acme.de"]);

      const patterns = survivor.learnedPatterns as Doc[];
      expect(patterns.map((p) => p.pattern)).toEqual(["*acme*", "*acme*handels*"]);
      expect(patterns[0].confidence).toBe(92);

      expect((survivor.manualRemovals as Doc[]).map((r) => r.transactionId)).toEqual([
        "tx-veto-s",
        "tx-veto-l",
      ]);
      expect((survivor.manualFileRemovals as Doc[]).map((r) => r.fileId)).toEqual([
        "file-veto-s",
        "file-veto-l",
      ]);
      expect((survivor.fileSourcePatterns as Doc[]).map((p) => p.pattern)).toEqual([
        "from:acme.at",
        "from:acme.de",
      ]);
      expect((survivor.emailSearchPatterns as Doc[]).map((p) => p.pattern)).toEqual([
        "from:acme.at invoice",
        "from:acme.de rechnung",
      ]);
      expect((survivor.invoiceLinks as Doc[]).map((l) => l.url)).toEqual([
        "https://acme.at/inv/1",
        "https://acme.de/inv/2",
      ]);
      expect((survivor.browserRecipes as Doc[]).map((r) => r.domain)).toEqual([
        "acme.at",
        "acme.de",
      ]);
      expect((survivor.categoryMatchRules as Doc[]).map((r) => r.categoryId)).toEqual([
        "cat-private",
        "cat-office",
      ]);
      expect((survivor.categoryManualRemovals as Doc[]).map((r) => r.transactionId)).toEqual([
        "tx-cat-s",
        "tx-cat-l",
      ]);
    });

    it("keeps the newest negative signals when the union exceeds the stored cap", () => {
      const entries = (prefix: string, count: number, startDay: number) =>
        Array.from({ length: count }, (_, i) => ({
          transactionId: `${prefix}-${i}`,
          removedAt: ts(`2026-01-${String(startDay + i).padStart(2, "0")}`),
          partner: "Acme",
          name: "x",
        }));

      const merged = mergePartnerFields(
        { name: "Acme GmbH", manualRemovals: entries("old", 30, 1) },
        [{ id: "loser", name: "Acme Gmbh", manualRemovals: entries("new", 30, 1) }],
        { toDate: () => new Date("2026-03-01") } as never
      );

      const kept = merged.survivorUpdates.manualRemovals as Doc[];
      expect(kept).toHaveLength(50);
      // The ten oldest of the sixty fell off, newest kept regardless of side.
      expect(kept.some((r) => r.transactionId === "old-29")).toBe(true);
      expect(kept.some((r) => r.transactionId === "new-29")).toBe(true);
      expect(kept.some((r) => r.transactionId === "old-0")).toBe(false);
    });
  });

  // ==========================================================================
  // VAT IDs
  // ==========================================================================

  describe("differing VAT IDs", () => {
    it("refuses the merge until the caller affirms it separately", async () => {
      seedPartner("survivor", { name: "Acme GmbH", vatId: "ATU99999999" });
      seedPartner("loser", { name: "Acme Gmbh", vatId: "ATU12345678" });

      await expect(merge("survivor", ["loser"])).rejects.toThrow(/different VAT IDs/);
      // Nothing moved: the refusal happens before the first write.
      expect(partnerDoc("loser").isActive).toBe(true);
      expect(partnerDoc("loser").mergedInto).toBeUndefined();
    });

    it("goes through on the affirmation, keeping the survivor's own", async () => {
      seedPartner("survivor", { name: "Acme GmbH", vatId: "ATU99999999" });
      seedPartner("loser", { name: "Acme Gmbh", vatId: "ATU12345678" });

      const result = await merge("survivor", ["loser"], { confirmVatIdConflict: true });

      expect(partnerDoc("survivor").vatId).toBe("ATU99999999");
      expect(partnerDoc("loser").mergeConflicts).toEqual([
        { field: "vatId", value: "ATU12345678", survivorValue: "ATU99999999" },
      ]);
      expect(result.conflicts).toEqual([{ partnerId: "loser", fields: ["vatId"] }]);
    });

    it("treats two losers disagreeing as the same warning", async () => {
      seedPartner("survivor", { name: "Acme GmbH" });
      seedPartner("loser-a", { name: "Acme Gmbh", vatId: "ATU11111111" });
      seedPartner("loser-b", { name: "ACME", vatId: "ATU22222222" });

      await expect(merge("survivor", ["loser-a", "loser-b"])).rejects.toThrow(
        /different VAT IDs/
      );
    });

    it("does not warn when the same VAT ID is merely written differently", async () => {
      seedPartner("survivor", { name: "Acme GmbH", vatId: "ATU12345678" });
      seedPartner("loser", { name: "Acme Gmbh", vatId: "atu 123 456 78" });

      await expect(merge("survivor", ["loser"])).resolves.toMatchObject({ success: true });
    });
  });

  // ==========================================================================
  // Chains
  // ==========================================================================

  describe("chains", () => {
    it("leaves no Merged Partner pointing at a Merged Partner across three", async () => {
      seedPartner("a", { name: "Acme A" });
      seedPartner("b", { name: "Acme B" });
      seedPartner("c", { name: "Acme C" });

      await merge("b", ["a"]);
      expect(partnerDoc("a").mergedInto).toBe("b");

      const result = await merge("c", ["b"]);

      expect(result.repointed.mergedPartners).toBe(1);
      expect(partnerDoc("b").mergedInto).toBe("c");
      // One hop from a live Partner, so no consumer needs loop detection.
      expect(partnerDoc("a").mergedInto).toBe("c");
      expect(partnerDoc("c").isActive).toBe(true);
      expect(partnerDoc("c").mergedInto).toBeUndefined();
    });

    it("refuses to merge into a Merged Partner", async () => {
      seedPartner("survivor", { name: "Acme GmbH" });
      seedPartner("loser", { name: "Acme Gmbh" });
      seedPartner("newcomer", { name: "Acme Handels" });
      await merge("survivor", ["loser"]);

      await expect(merge("loser", ["newcomer"])).rejects.toThrow(/Merged Partner/);
      expect(partnerDoc("newcomer").isActive).toBe(true);
    });

    it("allows merging a Merged Partner away, with nothing left to repoint", async () => {
      seedPartner("survivor", { name: "Acme GmbH" });
      seedPartner("loser", { name: "Acme Gmbh" });
      seedPartner("elsewhere", { name: "Acme Elsewhere" });
      store.setDoc(
        "transactions",
        "tx-1",
        createTestTransaction({ userId: USER, partnerId: "loser", partnerType: "user" })
      );
      await merge("survivor", ["loser"]);

      const result = await merge("elsewhere", ["loser"]);

      expect(result.repointed.transactions).toBe(0);
      expect(result.repointed.files).toBe(0);
      expect(result.repointed.invoices).toBe(0);
      expect(partnerDoc("loser").mergedInto).toBe("elsewhere");
      // The reference moved at the first merge and stays where it went.
      expect(store.getDoc("transactions", "tx-1")!.partnerId).toBe("survivor");
    });
  });

  // ==========================================================================
  // The identity marker (#307)
  // ==========================================================================

  /**
   * `identitySourceField` decides where a Partner is edited — "Edit in
   * Identity" instead of the Partner page — so it is not an ordinary single
   * value the survivor fills from an empty slot. It moves only with the
   * identity entity that produced it.
   */
  describe("the identity marker", () => {
    function seedCompanyEntity(partnerId: string): void {
      store.setDoc(`users/${USER}/settings`, "userData", {
        companies: [{ id: "c1", type: "company", name: "Felix GmbH", partnerId }],
      });
    }

    it("does not make an ordinary survivor identity-synced", async () => {
      seedPartner("survivor", { name: "Acme GmbH" });
      seedPartner("loser", { name: "Acme Gmbh", identitySourceField: "source:card-1" });

      await merge("survivor", ["loser"]);

      expect(partnerDoc("survivor").identitySourceField).toBeUndefined();
      // It stays where it was: a Merged Partner reads back as itself.
      expect(partnerDoc("loser").identitySourceField).toBe("source:card-1");
    });

    it("hands the marker over where the identity entity itself moves", async () => {
      seedPartner("survivor", { name: "Felix GmbH" });
      seedPartner("loser", { name: "Felix Gesellschaft", identitySourceField: "company:c1" });
      seedCompanyEntity("loser");

      const result = await merge("survivor", ["loser"]);

      expect(result.repointed.identityReferences).toBe(1);
      const companies = store.getDoc(`users/${USER}/settings`, "userData")!.companies as Doc[];
      expect(companies[0].partnerId).toBe("survivor");
      // The survivor IS that company's Partner now, so the marker is the
      // entity repoint's own consequence, not an empty-value fill.
      expect(partnerDoc("survivor").identitySourceField).toBe("company:c1");
    });

    it("marks the survivor for the personal entity it took over", async () => {
      seedPartner("survivor", { name: "Felix Mustermann" });
      seedPartner("loser", { name: "F. Mustermann" });
      store.setDoc(`users/${USER}/settings`, "userData", {
        personalEntity: { id: "pe", type: "person", name: "Felix", partnerId: "loser" },
      });

      await merge("survivor", ["loser"]);

      expect(partnerDoc("survivor").identitySourceField).toBe("personalEntity");
    });

    it("marks a survivor that swallows two identity Partners for one of them", async () => {
      seedPartner("survivor", { name: "Felix" });
      seedPartner("loser-personal", { name: "F. Mustermann", identitySourceField: "personalEntity" });
      seedPartner("loser-company", { name: "Felix GmbH", identitySourceField: "company:c1" });
      store.setDoc(`users/${USER}/settings`, "userData", {
        personalEntity: { id: "pe", type: "person", name: "Felix", partnerId: "loser-personal" },
        companies: [{ id: "c1", type: "company", name: "Felix GmbH", partnerId: "loser-company" }],
      });

      const result = await merge("survivor", ["loser-personal", "loser-company"]);

      // Both entities name the survivor now; the marker names the first of
      // them rather than whichever entity the loop reached last.
      expect(result.repointed.identityReferences).toBe(2);
      expect(partnerDoc("survivor").identitySourceField).toBe("personalEntity");
      // The marker the survivor did not take is a value its own beat, so it is
      // recorded on that loser's Merged Partner.
      expect(partnerDoc("loser-company").mergeConflicts).toEqual([
        {
          field: "identitySourceField",
          value: "company:c1",
          survivorValue: "personalEntity",
        },
      ]);
    });

    it("mints no marker for a deprecated identityPartnerIds pointer", async () => {
      seedPartner("survivor", { name: "Acme GmbH" });
      seedPartner("loser", { name: "Acme Gmbh", identitySourceField: "name" });
      store.setDoc(`users/${USER}/settings`, "userData", {
        identityPartnerIds: { name: "loser" },
      });

      const result = await merge("survivor", ["loser"]);

      expect(result.repointed.identityReferences).toBe(1);
      const userData = store.getDoc(`users/${USER}/settings`, "userData")!;
      expect((userData.identityPartnerIds as Doc).name).toBe("survivor");
      // The legacy spelling of a pointer is not an entity identity sync
      // maintains, so nothing is minted from it.
      expect(partnerDoc("survivor").identitySourceField).toBeUndefined();
    });

    it("keeps the survivor's own marker and records the loser's on the Merged Partner", async () => {
      seedPartner("survivor", { name: "Felix GmbH", identitySourceField: "personalEntity" });
      seedPartner("loser", { name: "Felix Gesellschaft", identitySourceField: "company:c1" });
      seedCompanyEntity("loser");

      await merge("survivor", ["loser"]);

      expect(partnerDoc("survivor").identitySourceField).toBe("personalEntity");
      expect(partnerDoc("loser").mergeConflicts).toEqual([
        {
          field: "identitySourceField",
          value: "company:c1",
          survivorValue: "personalEntity",
        },
      ]);
    });
  });

  // ==========================================================================
  // The rematch preview
  // ==========================================================================

  describe("the rematch preview", () => {
    beforeEach(() => {
      seedPartner("survivor", { name: "Zeta Services" });
      seedPartner("loser", {
        name: "Zeta Handels",
        ibans: ["AT611904300234573201"],
        manualRemovals: [
          { transactionId: "tx-vetoed", removedAt: ts("2026-01-01"), partner: "Zeta", name: "x" },
        ],
      });

      // Hit only by the IBAN the survivor gains.
      store.setDoc(
        "transactions",
        "tx-newly-matchable",
        createTestTransaction({
          userId: USER,
          partner: "Unrelated Counterparty",
          name: "SEPA Ueberweisung",
          partnerIban: "AT61 1904 3002 3457 3201",
        })
      );
      // Already hit by the survivor's own name, so the merge unlocked nothing.
      store.setDoc(
        "transactions",
        "tx-already-matched",
        createTestTransaction({ userId: USER, partner: "Zeta Services", name: "Zeta Services" })
      );
      // Hit by the new IBAN, but the user pulled it off the loser by hand.
      store.setDoc(
        "transactions",
        "tx-vetoed",
        createTestTransaction({
          userId: USER,
          partner: "Unrelated Counterparty",
          name: "SEPA Ueberweisung",
          partnerIban: "AT611904300234573201",
        })
      );
      // Hit by the new IBAN, but over the plan's transaction quota, so no
      // matching path will ever assign it a Partner.
      store.setDoc(
        "transactions",
        "tx-over-quota",
        createTestTransaction({
          userId: USER,
          partner: "Unrelated Counterparty",
          name: "SEPA Ueberweisung",
          partnerIban: "AT611904300234573201",
          quotaExceeded: true,
        })
      );
    });

    it("counts what the new identifying data would hit and rematches nothing", async () => {
      const result = await merge("survivor", ["loser"]);

      expect(result.rematchPreview.newlyMatchable).toBe(1);
      expect(result.rematchPreview.truncated).toBe(false);
      expect(result.rematchPreview.scanned).toBe(4);

      // No rematch ran: every unmatched transaction is still unmatched.
      expect(store.getDoc("transactions", "tx-newly-matchable")!.partnerId).toBeNull();
      expect(store.getDoc("transactions", "tx-already-matched")!.partnerId).toBeNull();
      expect(store.getDoc("transactions", "tx-vetoed")!.partnerId).toBeNull();
      expect(store.getDoc("transactions", "tx-over-quota")!.partnerId).toBeNull();
    });
  });

  // ==========================================================================
  // The merge marker (#306)
  // ==========================================================================

  /**
   * The marker is what `onPartnerUpdate` reads to leave a merge alone, so the
   * criterion that matters here is coverage: every Partner document the merge
   * writes carries it, not just the losers. A guard hanging off `mergedInto`
   * covered the loser side only, which is how the survivor's own 200-file
   * rematch went unnoticed.
   */
  describe("the merge marker", () => {
    it("stamps the survivor and every loser with the same merge id", async () => {
      seedPartner("survivor", { name: "Acme GmbH" });
      seedPartner("loser-a", { name: "Acme Gmbh" });
      seedPartner("loser-b", { name: "ACME Handels" });

      await merge("survivor", ["loser-a", "loser-b"]);

      const stamped = partnerDoc("survivor").mergeWriteId;
      expect(typeof stamped).toBe("string");
      expect(stamped).not.toBe("");
      expect(partnerDoc("loser-a").mergeWriteId).toBe(stamped);
      expect(partnerDoc("loser-b").mergeWriteId).toBe(stamped);
    });

    it("stamps a rewritten Merged Partner, and each merge gets its own id", async () => {
      seedPartner("a", { name: "Acme A" });
      seedPartner("b", { name: "Acme B" });
      seedPartner("c", { name: "Acme C" });

      await merge("b", ["a"]);
      const first = partnerDoc("a").mergeWriteId;

      await merge("c", ["b"]);
      const second = partnerDoc("c").mergeWriteId;

      expect(second).not.toBe(first);
      expect(partnerDoc("b").mergeWriteId).toBe(second);
      // Rewritten on the way, so its own write is recognisable as this merge's.
      expect(partnerDoc("a").mergeWriteId).toBe(second);
    });
  });

  // ==========================================================================
  // Refusals
  // ==========================================================================

  describe("refusals", () => {
    beforeEach(() => {
      seedPartner("survivor", { name: "Acme GmbH" });
      seedPartner("loser", { name: "Acme Gmbh" });
    });

    it("requires a survivor", async () => {
      await expect(merge("", ["loser"])).rejects.toThrow("survivorId is required");
    });

    it("requires at least one loser", async () => {
      await expect(merge("survivor", [])).rejects.toThrow(/at least one partner/);
    });

    it("refuses to merge a partner into itself", async () => {
      await expect(merge("survivor", ["survivor"])).rejects.toThrow(/into itself/);
    });

    it("refuses a partner that does not exist", async () => {
      await expect(merge("survivor", ["ghost"])).rejects.toThrow("Partner ghost not found");
    });

    it("refuses a partner belonging to someone else", async () => {
      store.setDoc("partners", "theirs", createTestPartner({ userId: OTHER_USER }));
      await expect(merge("survivor", ["theirs"])).rejects.toThrow("Access denied");
    });

    it("folds a repeated loser id into one", async () => {
      const result = await merge("survivor", ["loser", "loser"]);
      expect(result.mergedPartnerIds).toEqual(["loser"]);
    });
  });

  // ==========================================================================
  // The callable
  // ==========================================================================

  it("runs the same operation through the callable", async () => {
    seedPartner("survivor", { name: "Acme GmbH" });
    seedPartner("loser", { name: "Acme Gmbh" });

    const ctx = {
      userId: USER,
      db: db(),
      request: { auth: { uid: USER }, data: {} },
      logAIUsage: vi.fn(),
    };

    const result = await mergeUserPartnersCallable(ctx as any, {
      survivorId: "survivor",
      loserIds: ["loser"],
    });

    expect(result.success).toBe(true);
    expect(partnerDoc("loser").mergedInto).toBe("survivor");
  });
});
