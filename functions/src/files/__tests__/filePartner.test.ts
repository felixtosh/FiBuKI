/**
 * A File's Partner through the one server path (#627).
 *
 * The File detail panel and the Files list call `assignPartnerToFile` /
 * `removePartnerFromFile` through their callables; MCP's
 * `assign_partner_to_file` / `remove_partner_from_file` and the chat agent
 * call the same functions through `handleTool`. These tests sit at that
 * shared interface: which Partner may be assigned, what a removal records on
 * the Partner, and the Partner worker cancelled on a manual assign. The last
 * block holds the UI and MCP to the same records.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { store, createMockFirestore, createTestPartner, createTestFile } from "../../test/setup";

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
  }

  return {
    getFirestore: () => createMockFirestore(),
    FieldValue: {
      serverTimestamp: () => new Date(),
      arrayUnion: (...elements: unknown[]) => ({
        elements,
        constructor: { name: "ArrayUnionTransform" },
      }),
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
      message: string
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
vi.mock("firebase-functions/params", () => ({
  defineSecret: (name: string) => ({ value: () => `test-${name}` }),
}));

const filePartner = await import("../filePartner");
const handlers = await import("../../tools/handlers");

const USER = "user-file-partner";
const OTHER_USER = "someone-else";

type Doc = Record<string, unknown>;
type Callable = (ctx: unknown, data: unknown) => Promise<Doc>;

const db = () => createMockFirestore() as unknown as FirebaseFirestore.Firestore;
const doc = (collection: string, id: string) => store.getDoc(collection, id) as Doc;

function seedPartner(id: string, data: Doc = {}): void {
  store.setDoc("partners", id, createTestPartner({ userId: USER, ...data }));
}

function seedFile(id: string, data: Doc = {}): void {
  store.setDoc("files", id, createTestFile({ userId: USER, ...data }));
}

/** The UI's door: the callables the browser's file-ops call. */
function uiAssign(data: Doc) {
  return (filePartner.assignPartnerToFileCallable as unknown as Callable)({ db: db(), userId: USER }, data);
}
function uiRemove(data: Doc) {
  return (filePartner.removePartnerFromFileCallable as unknown as Callable)({ db: db(), userId: USER }, data);
}

/** The partner fields the File carries, and the Partner's removal list. */
function records(fileId: string, partnerId: string) {
  const file = doc("files", fileId);
  const removals = (doc("partners", partnerId).manualFileRemovals as Doc[] | undefined)?.map(
    ({ removedAt: _removedAt, ...rest }) => rest
  );
  return {
    file: {
      partnerId: file.partnerId,
      partnerType: file.partnerType,
      partnerMatchedBy: file.partnerMatchedBy,
      partnerMatchConfidence: file.partnerMatchConfidence,
    },
    removals,
  };
}

describe("assignPartnerToFile", () => {
  beforeEach(() => store.clear());
  afterEach(() => vi.clearAllMocks());

  it("assigns the User's own Partner and cancels the Partner worker", async () => {
    seedPartner("p-1", { name: "AL&FA Taxi KG" });
    seedFile("f-1", { partnerId: "p-wrong", partnerType: "user", partnerMatchedBy: "auto" });

    const result = await filePartner.assignPartnerToFile(db(), USER, {
      fileId: "f-1",
      partnerId: "p-1",
      partnerType: "user",
      matchedBy: "manual",
      confidence: 100,
    });

    expect(result).toEqual({
      fileId: "f-1",
      partnerId: "p-1",
      partnerName: "AL&FA Taxi KG",
      previousPartnerId: "p-wrong",
    });
    expect(doc("files", "f-1")).toMatchObject({
      partnerId: "p-1",
      partnerType: "user",
      partnerMatchedBy: "manual",
      partnerMatchConfidence: 100,
    });
    expect(cancelWorkers.cancelPartnerWorkersForFile).toHaveBeenCalledWith(USER, "f-1");
  });

  it("cancels the Partner worker on an accepted suggestion, not on an automatic one", async () => {
    seedPartner("p-1");
    seedFile("f-1");
    seedFile("f-2");

    await filePartner.assignPartnerToFile(db(), USER, {
      fileId: "f-1", partnerId: "p-1", partnerType: "user", matchedBy: "suggestion", confidence: 85,
    });
    await filePartner.assignPartnerToFile(db(), USER, {
      fileId: "f-2", partnerId: "p-1", partnerType: "user", matchedBy: "auto", confidence: 93,
    });

    expect(cancelWorkers.cancelPartnerWorkersForFile).toHaveBeenCalledTimes(1);
    expect(cancelWorkers.cancelPartnerWorkersForFile).toHaveBeenCalledWith(USER, "f-1");
    expect(doc("files", "f-2")).toMatchObject({ partnerMatchedBy: "auto", partnerMatchConfidence: 93 });
  });

  it("assigns a Global Partner", async () => {
    store.setDoc("globalPartners", "g-1", { name: "Amazon EU S.a.r.l." });
    seedFile("f-1");

    const result = await filePartner.assignPartnerToFile(db(), USER, {
      fileId: "f-1", partnerId: "g-1", partnerType: "global", matchedBy: "manual", confidence: 100,
    });

    expect(result.partnerName).toBe("Amazon EU S.a.r.l.");
    expect(doc("files", "f-1")).toMatchObject({ partnerId: "g-1", partnerType: "global" });
  });

  it("refuses another User's Partner, however it is typed, and a missing one", async () => {
    store.setDoc("partners", "p-theirs", createTestPartner({ userId: OTHER_USER }));
    seedFile("f-1");

    for (const [partnerId, partnerType] of [
      ["p-theirs", "user"],
      ["p-theirs", "global"],
      ["no-such-partner", "user"],
    ] as const) {
      await expect(
        filePartner.assignPartnerToFile(db(), USER, {
          fileId: "f-1", partnerId, partnerType, matchedBy: "manual", confidence: 100,
        })
      ).rejects.toThrow("Partner not found");
    }
    expect(doc("files", "f-1").partnerId).toBeUndefined();
    expect(cancelWorkers.cancelPartnerWorkersForFile).not.toHaveBeenCalled();
  });

  it("refuses another User's File", async () => {
    seedPartner("p-1");
    store.setDoc("files", "f-theirs", createTestFile({ userId: OTHER_USER }));

    await expect(
      filePartner.assignPartnerToFile(db(), USER, {
        fileId: "f-theirs", partnerId: "p-1", partnerType: "user", matchedBy: "manual", confidence: 100,
      })
    ).rejects.toThrow("File not found");
    expect(doc("files", "f-theirs").partnerId).toBeUndefined();
  });

  it("refuses a Merged Partner, naming its survivor", async () => {
    seedPartner("p-old", { isActive: false, mergedInto: "p-new" });
    seedFile("f-1");

    await expect(
      filePartner.assignPartnerToFile(db(), USER, {
        fileId: "f-1", partnerId: "p-old", partnerType: "user", matchedBy: "manual", confidence: 100,
      })
    ).rejects.toThrow(/merged into p-new/);
    expect(doc("files", "f-1").partnerId).toBeUndefined();
  });

  it("clears an earlier removal of the same pair", async () => {
    seedPartner("p-1", {
      manualFileRemovals: [
        { fileId: "f-1", extractedPartner: "X" },
        { fileId: "f-other", extractedPartner: "Y" },
      ],
    });
    seedFile("f-1");

    await filePartner.assignPartnerToFile(db(), USER, {
      fileId: "f-1", partnerId: "p-1", partnerType: "user", matchedBy: "manual", confidence: 100,
    });

    expect(doc("partners", "p-1").manualFileRemovals).toEqual([{ fileId: "f-other", extractedPartner: "Y" }]);
  });

  it("an accepted suggestion clears the removal; an automatic assignment never overrules it", async () => {
    seedPartner("p-1", {
      manualFileRemovals: [
        { fileId: "f-1", extractedPartner: "X" },
        { fileId: "f-2", extractedPartner: "Y" },
      ],
    });
    seedFile("f-1");
    seedFile("f-2");

    await filePartner.assignPartnerToFile(db(), USER, {
      fileId: "f-1", partnerId: "p-1", partnerType: "user", matchedBy: "suggestion", confidence: 85,
    });
    await filePartner.assignPartnerToFile(db(), USER, {
      fileId: "f-2", partnerId: "p-1", partnerType: "user", matchedBy: "auto", confidence: 93,
    });

    expect(doc("partners", "p-1").manualFileRemovals).toEqual([{ fileId: "f-2", extractedPartner: "Y" }]);
    expect(doc("files", "f-2")).toMatchObject({ partnerId: "p-1", partnerMatchedBy: "auto" });
  });

  it("writes no alias itself: matchFilePartner learns it, with its Invoicing Agent guard", async () => {
    seedPartner("p-1", { name: "AL&FA Taxi KG", aliases: ["AL&FA"] });
    seedFile("f-1", {
      extractedPartner: "Agent Platform GmbH",
      extractedInvoicingAgent: { name: "Agent Platform GmbH" },
    });

    await filePartner.assignPartnerToFile(db(), USER, {
      fileId: "f-1", partnerId: "p-1", partnerType: "user", matchedBy: "manual", confidence: 100,
    });

    expect(doc("partners", "p-1").aliases).toEqual(["AL&FA"]);
  });

  it("the chat agent's assignment is ai, keeps the confidence and the removal list (#665)", async () => {
    seedPartner("p-1", { manualFileRemovals: [{ fileId: "f-1", extractedPartner: "X" }] });
    seedFile("f-1", { partnerMatchConfidence: 42 });

    await filePartner.assignPartnerToFile(db(), USER, {
      fileId: "f-1", partnerId: "p-1", partnerType: "user", matchedBy: "ai",
    });

    expect(doc("files", "f-1")).toMatchObject({ partnerMatchedBy: "ai", partnerMatchConfidence: 42 });
    expect(doc("partners", "p-1").manualFileRemovals).toEqual([{ fileId: "f-1", extractedPartner: "X" }]);
    expect(cancelWorkers.cancelPartnerWorkersForFile).not.toHaveBeenCalled();
  });

  it("the callable refuses fields it does not take and a matchedBy the UI does not send", async () => {
    seedPartner("p-1");
    seedFile("f-1");

    await expect(
      uiAssign({ fileId: "f-1", partnerId: "p-1", partnerType: "user", matchedBy: "manual", userId: OTHER_USER })
    ).rejects.toThrow(/does not take userId/);
    await expect(
      uiAssign({ fileId: "f-1", partnerId: "p-1", partnerType: "user", matchedBy: "ai" })
    ).rejects.toThrow(/matchedBy/);
    await expect(
      uiAssign({ fileId: "f-1", partnerId: "p-1", partnerType: "other", matchedBy: "manual" })
    ).rejects.toThrow(/partnerType/);
    for (const confidence of [1e9, -1, "90"]) {
      await expect(
        uiAssign({ fileId: "f-1", partnerId: "p-1", partnerType: "user", matchedBy: "manual", confidence })
      ).rejects.toThrow(/confidence/);
    }
    await expect(uiRemove({ fileId: "f-1", partnerId: "p-1" })).rejects.toThrow(/does not take partnerId/);
    expect(doc("files", "f-1").partnerId).toBeUndefined();
  });
});

describe("removePartnerFromFile", () => {
  beforeEach(() => store.clear());
  afterEach(() => vi.clearAllMocks());

  it("records the removal of an automatic assignment on the Partner", async () => {
    seedPartner("p-1");
    seedFile("f-1", {
      partnerId: "p-1",
      partnerType: "user",
      partnerMatchedBy: "auto",
      partnerMatchConfidence: 91,
      extractedPartner: "Agent Platform GmbH",
      fileName: "rechnung.pdf",
    });

    const result = await filePartner.removePartnerFromFile(db(), USER, "f-1");

    expect(result).toEqual({ fileId: "f-1", previousPartnerId: "p-1", recordedAsFalsePositive: true });
    expect(doc("files", "f-1")).toMatchObject({
      partnerId: null,
      partnerType: null,
      partnerMatchedBy: null,
      partnerMatchConfidence: null,
    });
    expect(doc("partners", "p-1").manualFileRemovals).toEqual([
      expect.objectContaining({ fileId: "f-1", extractedPartner: "Agent Platform GmbH", fileName: "rechnung.pdf" }),
    ]);
  });

  it("records an accepted suggestion once, however often it is removed", async () => {
    seedPartner("p-1", { manualFileRemovals: [{ fileId: "f-1", extractedPartner: null }] });
    seedFile("f-1", { partnerId: "p-1", partnerType: "user", partnerMatchedBy: "suggestion" });

    const result = await filePartner.removePartnerFromFile(db(), USER, "f-1");

    expect(result.recordedAsFalsePositive).toBe(true);
    expect(doc("partners", "p-1").manualFileRemovals).toHaveLength(1);
  });

  it("a failed Partner write is logged, not thrown: the File change stands", async () => {
    seedPartner("p-1");
    seedFile("f-1", { partnerId: "p-1", partnerType: "user", partnerMatchedBy: "auto" });
    const realSet = store.setDoc.bind(store);
    const spy = vi.spyOn(store, "setDoc").mockImplementation((collection, id, data) => {
      if (collection === "partners") throw new Error("partner write failed");
      realSet(collection, id, data);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await filePartner.removePartnerFromFile(db(), USER, "f-1");

      expect(result.recordedAsFalsePositive).toBe(false);
      expect(doc("files", "f-1").partnerId).toBeNull();
      expect(log).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      log.mockRestore();
    }
  });

  it("does not record a manual assignment", async () => {
    seedPartner("p-1");
    seedFile("f-1", { partnerId: "p-1", partnerType: "user", partnerMatchedBy: "manual" });

    const result = await filePartner.removePartnerFromFile(db(), USER, "f-1");

    expect(result.recordedAsFalsePositive).toBe(false);
    expect(doc("partners", "p-1").manualFileRemovals).toBeUndefined();
    expect(doc("files", "f-1").partnerId).toBeNull();
  });

  it("never writes another User's Partner", async () => {
    store.setDoc("partners", "p-theirs", createTestPartner({ userId: OTHER_USER }));
    seedFile("f-1", { partnerId: "p-theirs", partnerType: "user", partnerMatchedBy: "auto" });

    const result = await filePartner.removePartnerFromFile(db(), USER, "f-1");

    expect(result.recordedAsFalsePositive).toBe(false);
    expect(doc("partners", "p-theirs").manualFileRemovals).toBeUndefined();
  });

  it("refuses another User's File", async () => {
    store.setDoc("files", "f-theirs", createTestFile({ userId: OTHER_USER, partnerId: "p-x" }));

    await expect(filePartner.removePartnerFromFile(db(), USER, "f-theirs")).rejects.toThrow("File not found");
    expect(doc("files", "f-theirs").partnerId).toBe("p-x");
  });
});

describe("the UI and MCP write the same records", () => {
  beforeEach(() => store.clear());
  afterEach(() => vi.clearAllMocks());

  function seedPair() {
    seedPartner("p-1", { manualFileRemovals: [{ fileId: "f-1", extractedPartner: "X" }] });
    seedFile("f-1", { partnerId: "p-wrong", partnerType: "user", partnerMatchedBy: "auto" });
  }

  it("for a manual assign", async () => {
    seedPair();
    await uiAssign({ fileId: "f-1", partnerId: "p-1", partnerType: "user", matchedBy: "manual", confidence: 100 });
    const ui = records("f-1", "p-1");

    store.clear();
    seedPair();
    const mcp = (await handlers.handleTool(USER, "assign_partner_to_file", { fileId: "f-1", partnerId: "p-1" })) as Doc;

    expect(records("f-1", "p-1")).toEqual(ui);
    expect(ui.file).toEqual({ partnerId: "p-1", partnerType: "user", partnerMatchedBy: "manual", partnerMatchConfidence: 100 });
    expect(mcp).toMatchObject({ success: true, fileId: "f-1", partnerId: "p-1", previousPartnerId: "p-wrong" });
    expect(cancelWorkers.cancelPartnerWorkersForFile).toHaveBeenCalledTimes(2);
  });

  it("for a remove", async () => {
    const seedAssigned = () => {
      seedPartner("p-1");
      seedFile("f-1", {
        partnerId: "p-1", partnerType: "user", partnerMatchedBy: "suggestion",
        partnerMatchConfidence: 80, extractedPartner: "Taxi", fileName: "taxi.pdf",
      });
    };
    seedAssigned();
    await uiRemove({ fileId: "f-1" });
    const ui = records("f-1", "p-1");

    store.clear();
    seedAssigned();
    const mcp = (await handlers.handleTool(USER, "remove_partner_from_file", { fileId: "f-1" })) as Doc;

    expect(records("f-1", "p-1")).toEqual(ui);
    expect(ui.removals).toEqual([{ fileId: "f-1", extractedPartner: "Taxi", fileName: "taxi.pdf" }]);
    expect(mcp).toEqual({ success: true, fileId: "f-1", previousPartnerId: "p-1", recordedAsFalsePositive: true });
  });
});

describe("updateFileInternal cancels the Partner worker only for a call it accepts", () => {
  beforeEach(() => store.clear());
  afterEach(() => vi.clearAllMocks());

  it("leaves the workers alone when the Partner or a field is refused", async () => {
    const { updateFileInternal } = await import("../updateFile");
    store.setDoc("partners", "p-theirs", createTestPartner({ userId: OTHER_USER }));
    seedPartner("p-1");
    seedFile("f-1");

    await expect(
      updateFileInternal(db(), USER, {
        fileId: "f-1",
        data: { partnerId: "p-theirs", partnerType: "user", partnerMatchedBy: "manual" },
      })
    ).rejects.toThrow("Partner not found");
    await expect(
      updateFileInternal(db(), USER, {
        fileId: "f-1",
        data: { partnerId: "p-1", partnerType: "user", partnerMatchedBy: "manual", userId: OTHER_USER } as never,
      })
    ).rejects.toThrow(/does not write userId/);
    expect(cancelWorkers.cancelPartnerWorkersForFile).not.toHaveBeenCalled();

    await updateFileInternal(db(), USER, {
      fileId: "f-1",
      data: { partnerId: "p-1", partnerType: "user", partnerMatchedBy: "manual" },
    });
    expect(cancelWorkers.cancelPartnerWorkersForFile).toHaveBeenCalledWith(USER, "f-1");
  });
});
