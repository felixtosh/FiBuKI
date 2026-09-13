/**
 * #164: assigning a no-receipt category must have exactly one writer, used
 * identically by the web operations layer (lib/operations/category-ops.ts,
 * via the assignNoReceiptCategory callable) and the MCP/tool surface
 * (functions/src/tools/handlers.ts). Before this, only the web path taught
 * the category matcher by adding the transaction's partner to the category's
 * matchedPartnerIds; the tool handler reimplemented the write and silently
 * skipped that step.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  store,
  createMockFirestore,
  createTestTransaction,
} from "../../test/setup";
import {
  matchTransactionToCategories,
  shouldAutoApplyCategory,
  CATEGORY_MATCH_CONFIG,
  TransactionData,
  CategoryData,
} from "../../utils/category-matcher";

// Minimal Timestamp/FieldValue stand-ins, matching the mock the tool-handler
// tests use: the in-memory store compares/serializes via a plain Date, and
// increment/arrayUnion are unwrapped explicitly rather than left as opaque
// transform sentinels.
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
      arrayUnion: (...elements: unknown[]) => ({ elements, constructor: { name: "ArrayUnionTransform" } }),
      arrayRemove: (...elements: unknown[]) => ({ elements, constructor: { name: "ArrayRemoveTransform" } }),
      increment: (n: number) => n,
      delete: () => ({ constructor: { name: "DeleteTransform" } }),
    },
    Timestamp: MockTimestamp,
  };
});

// createCallable normally wraps the handler in a live onCall() Cloud
// Function; tests only need the inner (ctx, request) => ... logic.
vi.mock("../../utils/createCallable", () => ({
  createCallable: <TReq, TRes>(
    _config: { name: string },
    handler: (ctx: unknown, data: TReq) => Promise<TRes>
  ) => handler,
  HttpsError: class HttpsError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
}));

vi.mock("../../extraction/extractionCore", () => ({ runExtraction: vi.fn() }));
vi.mock("firebase-functions/params", () => ({
  defineSecret: (name: string) => ({ value: () => `test-${name}` }),
}));

const { assignNoReceiptCategoryToTransaction, assignNoReceiptCategoryCallable } = await import(
  "../assignNoReceiptCategory"
);
const handlers = await import("../../tools/handlers");

const userId = "test-user-123";

function seedCategory(
  categoryId: string,
  overrides: Partial<Record<string, unknown>> = {}
) {
  store.setDoc("noReceiptCategories", categoryId, {
    userId,
    name: "Bank Fees",
    templateId: "bank-fees",
    isActive: true,
    transactionCount: 0,
    matchedPartnerIds: [],
    ...overrides,
  });
}

function seedTransaction(
  transactionId: string,
  overrides: Partial<Record<string, unknown>> = {}
) {
  store.setDoc(
    "transactions",
    transactionId,
    createTestTransaction({
      userId,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
      ...overrides,
    })
  );
}

/**
 * Drops the fields that legitimately differ between the two fixture copies:
 * updatedAt (re-stamped on every write) and the category/template id (the
 * fixtures use different ids per surface so they can share one store).
 */
function normalize(doc: Record<string, unknown> | undefined) {
  if (!doc) return doc;
  const { updatedAt: _updatedAt, noReceiptCategoryId: _categoryId, ...rest } = doc;
  return rest;
}

describe("assignNoReceiptCategoryToTransaction (#164 shared writer)", () => {
  beforeEach(() => {
    store.clear();
  });

  it("adds the transaction's partner to matchedPartnerIds and moves transactionCount together", async () => {
    seedTransaction("tx-1", { partnerId: "partner-1" });
    seedCategory("cat-1");

    const db = createMockFirestore();
    const result = await assignNoReceiptCategoryToTransaction(db as any, userId, {
      transactionId: "tx-1",
      categoryId: "cat-1",
      matchedBy: "manual",
    });

    expect(result.partnerAdded).toBe(true);

    const tx = store.getDoc("transactions", "tx-1");
    expect(tx?.noReceiptCategoryId).toBe("cat-1");
    expect(tx?.noReceiptCategoryMatchedBy).toBe("manual");
    expect(tx?.isComplete).toBe(true);

    const category = store.getDoc("noReceiptCategories", "cat-1");
    expect(category?.matchedPartnerIds).toEqual(["partner-1"]);
    expect(category?.transactionCount).toBe(1);
  });

  it("assigns cleanly and adds nothing to matchedPartnerIds when the transaction has no partner", async () => {
    seedTransaction("tx-2", { partnerId: null });
    seedCategory("cat-2");

    const db = createMockFirestore();
    const result = await assignNoReceiptCategoryToTransaction(db as any, userId, {
      transactionId: "tx-2",
      categoryId: "cat-2",
      matchedBy: "manual",
    });

    expect(result.partnerAdded).toBe(false);
    const tx = store.getDoc("transactions", "tx-2");
    expect(tx?.noReceiptCategoryId).toBe("cat-2");
    expect(tx?.isComplete).toBe(true);

    const category = store.getDoc("noReceiptCategories", "cat-2");
    expect(category?.matchedPartnerIds).toEqual([]);
  });

  it("does not duplicate a partner already in matchedPartnerIds", async () => {
    seedTransaction("tx-3", { partnerId: "partner-1" });
    seedCategory("cat-3", { matchedPartnerIds: ["partner-1"] });

    const db = createMockFirestore();
    const result = await assignNoReceiptCategoryToTransaction(db as any, userId, {
      transactionId: "tx-3",
      categoryId: "cat-3",
      matchedBy: "manual",
    });

    expect(result.partnerAdded).toBe(false);
    const category = store.getDoc("noReceiptCategories", "cat-3");
    expect(category?.matchedPartnerIds).toEqual(["partner-1"]);
  });

  it("the next transaction from a partner taught over the tool surface receives the suggestion, above the auto-apply threshold", async () => {
    seedTransaction("tx-taught", { partnerId: "partner-9" });
    seedCategory("cat-9");

    // Assign exactly as the tool handler does (no matchedBy override exposed).
    await handlers.assignNoReceiptCategory(userId, {
      transactionId: "tx-taught",
      categoryId: "cat-9",
    });

    const taughtCategory = store.getDoc("noReceiptCategories", "cat-9")!;
    expect(taughtCategory.matchedPartnerIds).toEqual(["partner-9"]);

    // A fresh, unrelated transaction from the same partner should now match.
    const nextTransaction: TransactionData = {
      id: "tx-next",
      partner: "Partner Nine",
      partnerId: "partner-9",
      name: "Partner Nine charge",
      reference: null,
      noReceiptCategoryId: null,
      fileIds: [],
    };
    const categoryData: CategoryData = {
      id: "cat-9",
      userId,
      templateId: taughtCategory.templateId as CategoryData["templateId"],
      name: taughtCategory.name as string,
      matchedPartnerIds: taughtCategory.matchedPartnerIds as string[],
      transactionCount: taughtCategory.transactionCount as number,
      isActive: true,
    };

    const suggestions = matchTransactionToCategories(nextTransaction, [categoryData]);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].categoryId).toBe("cat-9");
    expect(suggestions[0].confidence).toBeGreaterThanOrEqual(CATEGORY_MATCH_CONFIG.AUTO_APPLY_THRESHOLD);
    expect(shouldAutoApplyCategory(suggestions[0].confidence)).toBe(true);
  });

  it("does not teach the matcher when the assignment is only a suggestion", async () => {
    seedTransaction("tx-5", { partnerId: "partner-5" });
    seedCategory("cat-5");

    // The web surface passes matchedBy "suggestion" when the user accepts a
    // suggested category; only confirmed assignments may grow the matched
    // partner set, or accepting a suggestion would auto-apply the category to
    // every future transaction from that partner.
    const ctx = { userId, db: createMockFirestore(), request: {}, logAIUsage: vi.fn() };
    await (assignNoReceiptCategoryCallable as any)(ctx, {
      transactionId: "tx-5",
      categoryId: "cat-5",
      matchedBy: "suggestion",
    });

    const tx = store.getDoc("transactions", "tx-5");
    expect(tx?.noReceiptCategoryMatchedBy).toBe("suggestion");
    expect(tx?.isComplete).toBe(true);

    const category = store.getDoc("noReceiptCategories", "cat-5");
    expect(category?.matchedPartnerIds).toEqual([]);
    expect(category?.transactionCount).toBe(1);
  });

  it("rejects a category or transaction that does not belong to the caller", async () => {
    seedTransaction("tx-4", { partnerId: "partner-1" });
    seedCategory("cat-4", { userId: "someone-else" });

    const db = createMockFirestore();
    await expect(
      assignNoReceiptCategoryToTransaction(db as any, userId, {
        transactionId: "tx-4",
        categoryId: "cat-4",
        matchedBy: "manual",
      })
    ).rejects.toThrow("not found or access denied");
  });
});

describe("web callable and MCP tool handler write identical state from one fixture (#164)", () => {
  beforeEach(() => {
    store.clear();
  });

  it("produces byte-identical transaction and category state on both surfaces", async () => {
    // One fixture, seeded twice under different ids so both surfaces can run
    // against it independently in the same store.
    for (const suffix of ["web", "mcp"]) {
      seedTransaction(`tx-${suffix}`, { partnerId: "partner-shared" });
      seedCategory(`cat-${suffix}`);
    }

    // Web path: what lib/operations/category-ops.ts calls over httpsCallable.
    const ctx = { userId, db: createMockFirestore(), request: {}, logAIUsage: vi.fn() };
    await (assignNoReceiptCategoryCallable as any)(ctx, {
      transactionId: "tx-web",
      categoryId: "cat-web",
    });

    // MCP/tool path: the actual exported tool handler.
    await handlers.assignNoReceiptCategory(userId, {
      transactionId: "tx-mcp",
      categoryId: "cat-mcp",
    });

    expect(store.getDoc("transactions", "tx-web")?.noReceiptCategoryId).toBe("cat-web");
    expect(store.getDoc("transactions", "tx-mcp")?.noReceiptCategoryId).toBe("cat-mcp");

    const webTx = normalize(store.getDoc("transactions", "tx-web"));
    const mcpTx = normalize(store.getDoc("transactions", "tx-mcp"));
    expect(mcpTx).toEqual(webTx);

    const webCategory = normalize(store.getDoc("noReceiptCategories", "cat-web"));
    const mcpCategory = normalize(store.getDoc("noReceiptCategories", "cat-mcp"));
    expect(mcpCategory).toEqual(webCategory);

    expect(webCategory?.matchedPartnerIds).toEqual(["partner-shared"]);
    expect(webCategory?.transactionCount).toBe(1);
  });

  it("adds nothing to matchedPartnerIds on either surface when the transaction has no partner", async () => {
    for (const suffix of ["web", "mcp"]) {
      seedTransaction(`tx-${suffix}`, { partnerId: null });
      seedCategory(`cat-${suffix}`);
    }

    const ctx = { userId, db: createMockFirestore(), request: {}, logAIUsage: vi.fn() };
    await (assignNoReceiptCategoryCallable as any)(ctx, {
      transactionId: "tx-web",
      categoryId: "cat-web",
    });

    await handlers.assignNoReceiptCategory(userId, {
      transactionId: "tx-mcp",
      categoryId: "cat-mcp",
    });

    expect(store.getDoc("transactions", "tx-web")?.isComplete).toBe(true);
    expect(store.getDoc("transactions", "tx-mcp")?.isComplete).toBe(true);
    expect(store.getDoc("noReceiptCategories", "cat-web")?.matchedPartnerIds).toEqual([]);
    expect(store.getDoc("noReceiptCategories", "cat-mcp")?.matchedPartnerIds).toEqual([]);
  });
});
