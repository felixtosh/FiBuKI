/**
 * The import wizard's mapping writers store mappings through the one check the remap uses
 * (fieldMappings.ts, #628): an unknown target field or an extra key is refused before anything is
 * written, and a valid mapping is stored as sent, an unset format as null.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, createMockFirestore, createTestContext, createTestSource } from "../test/setup";

vi.mock("firebase-admin/firestore", () => {
  class FakeInstant {
    constructor(private readonly d: Date) {}
    static fromDate(d: Date) {
      return new FakeInstant(d);
    }
    static fromMillis(ms: number) {
      return new FakeInstant(new Date(ms));
    }
    static now() {
      return new FakeInstant(new Date());
    }
    toDate() {
      return this.d;
    }
  }
  return {
    getFirestore: () => createMockFirestore(),
    FieldValue: { serverTimestamp: () => new Date(), delete: () => ({ constructor: { name: "DeleteTransform" } }) },
    Timestamp: FakeInstant,
  };
});
vi.mock("../utils/createCallable", () => ({
  createCallable: <TReq, TRes>(_c: unknown, handler: (ctx: unknown, data: TReq) => Promise<TRes>) => handler,
  HttpsError: class HttpsError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
}));

const { createDraftImportCallable } = await import("./createDraftImport");
const { updateDraftMappingsCallable } = await import("./updateDraftMappings");
const { createImportRecordCallable } = await import("./createImportRecord");

type Run = (ctx: unknown, data: unknown) => Promise<{ importId?: string }>;
const createDraft = createDraftImportCallable as unknown as Run;
const updateDraft = updateDraftMappingsCallable as unknown as Run;
const createRecord = createImportRecordCallable as unknown as Run;

const USER = "user-wizard";
/** What the wizard sends: an unset format as null. */
const VALID = [
  { csvColumn: "Datum", targetField: "date", confidence: 0.9, userConfirmed: false, keepAsMetadata: false, format: "de" },
  { csvColumn: "Notiz", targetField: null, confidence: 0, userConfirmed: true, keepAsMetadata: true, format: null },
];
const OLD = [{ csvColumn: "Datum", targetField: "name", confidence: 0.4, userConfirmed: false, keepAsMetadata: false, format: null }];

const INVALID: Array<[string, unknown]> = [
  ["an unknown target field", [{ ...VALID[0], targetField: "userId" }]],
  ["an extra key", [{ ...VALID[0], userId: "intruder" }]],
  ["a list that is not one", { csvColumn: "Datum" }],
];

const mappingsOf = (id: string) => (store.getDoc("imports", id) as { fieldMappings: unknown }).fieldMappings;

beforeEach(() => {
  store.clear();
  store.setDoc("sources", "s1", createTestSource({ userId: USER, currency: "EUR" }));
  store.setDoc("imports", "draft-1", { userId: USER, sourceId: "s1", status: "draft", fieldMappings: OLD });
});

describe("updateDraftMappings", () => {
  it("stores a valid mapping as sent", async () => {
    await updateDraft(createTestContext(USER), { importId: "draft-1", fieldMappings: VALID });
    expect(mappingsOf("draft-1")).toEqual(VALID);
  });

  it.each(INVALID)("refuses %s and writes nothing", async (_name, fieldMappings) => {
    await expect(updateDraft(createTestContext(USER), { importId: "draft-1", fieldMappings })).rejects.toThrow();
    expect(mappingsOf("draft-1")).toEqual(OLD);
  });
});

describe("createImportRecord", () => {
  const request = (fieldMappings: unknown, importJobId = "draft-1") => ({
    importJobId,
    sourceId: "s1",
    fileName: "bank.csv",
    importedCount: 1,
    skippedCount: 0,
    errorCount: 0,
    totalRows: 1,
    fieldMappings,
  });

  it("stores a valid mapping as sent when it completes a draft", async () => {
    await createRecord(createTestContext(USER), request(VALID));
    expect(mappingsOf("draft-1")).toEqual(VALID);
  });

  it("stores a valid mapping as sent on a new record", async () => {
    await createRecord(createTestContext(USER), request(VALID, "job-new"));
    expect(mappingsOf("job-new")).toEqual(VALID);
  });

  it.each(INVALID)("refuses %s and writes nothing", async (_name, fieldMappings) => {
    await expect(createRecord(createTestContext(USER), request(fieldMappings))).rejects.toThrow();
    await expect(createRecord(createTestContext(USER), request(fieldMappings, "job-new"))).rejects.toThrow();
    expect(store.getDoc("imports", "draft-1")).toMatchObject({ status: "draft", fieldMappings: OLD });
    expect(store.getDoc("imports", "job-new")).toBeFalsy();
  });
});

describe("createDraftImport", () => {
  const request = (fieldMappings: unknown) => ({
    sourceId: "s1",
    fileName: "bank.csv",
    csvHash: "hash-new",
    csvStoragePath: "imports/bank.csv",
    csvDownloadUrl: "https://example.test/bank.csv",
    parseOptions: {},
    detectedHeaders: ["Datum", "Notiz"],
    sampleRows: [],
    totalRows: 1,
    fieldMappings,
  });

  it("stores a valid mapping as sent", async () => {
    const { importId } = await createDraft(createTestContext(USER), request(VALID));
    expect(mappingsOf(importId!)).toEqual(VALID);
  });

  it.each(INVALID)("refuses %s and writes nothing", async (_name, fieldMappings) => {
    await expect(createDraft(createTestContext(USER), request(fieldMappings))).rejects.toThrow();
    expect(store.getCollection("imports").size).toBe(1);
  });
});
