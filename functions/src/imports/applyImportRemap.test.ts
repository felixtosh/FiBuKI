import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, createMockFirestore, createTestContext, createTestSource } from "../test/setup";

vi.mock("firebase-admin/firestore", () => {
  class FakeInstant {
    constructor(private readonly d: Date) {}
    static fromDate(d: Date) {
      return new FakeInstant(d);
    }
    static now() {
      return new FakeInstant(new Date());
    }
    toDate() {
      return this.d;
    }
  }
  return { getFirestore: () => createMockFirestore(), FieldValue: { serverTimestamp: () => new Date() }, Timestamp: FakeInstant };
});
vi.mock("../utils/createCallable", () => ({
  createCallable: <TReq, TRes>(_c: unknown, handler: (ctx: unknown, data: TReq) => Promise<TRes>) => handler,
  HttpsError: class HttpsError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
}));

const { applyImportRemapCallable } = await import("./applyImportRemap");
const { computeDedupeHash } = await import("./dedupe");

const run = applyImportRemapCallable as unknown as (
  ctx: unknown,
  data: unknown
) => Promise<{ updated: number; skipped: number }>;

const USER = "user-remap";
const MAPPINGS = [
  { csvColumn: "Datum", targetField: "date", confidence: 1, userConfirmed: true, keepAsMetadata: false, format: "de" },
  { csvColumn: "Betrag", targetField: "amount", confidence: 1, userConfirmed: true, keepAsMetadata: false, format: "de" },
  { csvColumn: "Notiz", targetField: null, confidence: 0, userConfirmed: true, keepAsMetadata: true },
];
const OLD_MAPPINGS = [{ csvColumn: "Datum", targetField: "name", confidence: 0.4, userConfirmed: false, keepAsMetadata: false }];
const row = (transactionId: string, extra: Record<string, unknown> = {}) => ({
  transactionId,
  date: "2026-09-03T00:00:00.000Z",
  amount: -2390,
  name: "REWE",
  partner: "REWE",
  reference: "Einkauf 7",
  partnerIban: null,
  original: { date: "03.09.2026", amount: "-23,90", rawRow: { Datum: "03.09.2026" } },
  ...extra,
});

beforeEach(() => {
  store.clear();
  store.setDoc("sources", "s1", createTestSource({ userId: USER, iban: "AT12 3456", currency: "EUR" }));
  store.setDoc("imports", "job-1", { userId: USER, sourceId: "s1", status: "completed", fieldMappings: OLD_MAPPINGS });
  store.setDoc("imports", "card-job", { userId: USER, sourceId: "card", status: "completed", fieldMappings: OLD_MAPPINGS });
  store.setDoc("transactions", "t1", { userId: USER, importJobId: "job-1", amount: 1, name: "old", dedupeHash: "old" });
  store.setDoc("transactions", "t-other-import", { userId: USER, importJobId: "job-2", name: "keep" });
  store.setDoc("transactions", "t-other-user", { userId: "someone-else", importJobId: "job-1", name: "keep" });
});

const mappingsOf = (id: string) => (store.getDoc("imports", id) as { fieldMappings: unknown }).fieldMappings;

describe("applyImportRemap", () => {
  // #628: the new mappings are saved by the call that rewrites the Transactions.
  it("saves the new column mappings on the Import", async () => {
    await run(createTestContext(USER), { importJobId: "job-1", sourceId: "s1", fieldMappings: MAPPINGS, rows: [row("t1")] });
    expect(mappingsOf("job-1")).toEqual(MAPPINGS);
  });

  it("saves the mappings when no row parsed under them", async () => {
    await run(createTestContext(USER), { importJobId: "job-1", sourceId: "s1", fieldMappings: MAPPINGS, rows: [] });
    expect(mappingsOf("job-1")).toEqual(MAPPINGS);
  });

  it("keeps a format the wizard stored as null as null", async () => {
    const withNull = [{ ...MAPPINGS[2], format: null }];
    await run(createTestContext(USER), { importJobId: "job-1", sourceId: "s1", fieldMappings: withNull, rows: [] });
    expect(mappingsOf("job-1")).toEqual(withNull);
  });

  it("repeating a chunk is harmless", async () => {
    const request = { importJobId: "job-1", sourceId: "s1", fieldMappings: MAPPINGS, rows: [row("t1")] };
    await run(createTestContext(USER), request);
    const once = { ...(store.getDoc("transactions", "t1") as Record<string, unknown>) };
    const again = await run(createTestContext(USER), request);

    expect(again).toMatchObject({ updated: 1, skipped: 0 });
    const twice = store.getDoc("transactions", "t1") as Record<string, unknown>;
    const { updatedAt: _a, ...onceRest } = once;
    const { updatedAt: _b, ...twiceRest } = twice;
    expect(twiceRest).toEqual(onceRest);
    expect(mappingsOf("job-1")).toEqual(MAPPINGS);
  });

  it("refuses another User's Import and writes nothing", async () => {
    store.setDoc("sources", "s-intruder", createTestSource({ userId: "intruder", currency: "EUR" }));
    await expect(
      run(createTestContext("intruder"), { importJobId: "job-1", sourceId: "s-intruder", fieldMappings: MAPPINGS, rows: [] })
    ).rejects.toThrow(/denied/);
    expect(mappingsOf("job-1")).toEqual(OLD_MAPPINGS);
  });

  it("refuses an Import of another bank account and writes nothing", async () => {
    store.setDoc("sources", "s2", createTestSource({ userId: USER, currency: "EUR" }));
    await expect(
      run(createTestContext(USER), { importJobId: "job-1", sourceId: "s2", fieldMappings: MAPPINGS, rows: [row("t1")] })
    ).rejects.toThrow();
    expect(mappingsOf("job-1")).toEqual(OLD_MAPPINGS);
    expect((store.getDoc("transactions", "t1") as { name: string }).name).toBe("old");
  });

  it("refuses a missing Import", async () => {
    await expect(
      run(createTestContext(USER), { importJobId: "nope", sourceId: "s1", fieldMappings: MAPPINGS, rows: [] })
    ).rejects.toThrow(/not found/i);
  });

  it("refuses a draft Import: its mappings belong to the import wizard", async () => {
    store.setDoc("imports", "draft-1", { userId: USER, sourceId: "s1", status: "draft", fieldMappings: OLD_MAPPINGS });
    await expect(
      run(createTestContext(USER), { importJobId: "draft-1", sourceId: "s1", fieldMappings: MAPPINGS, rows: [] })
    ).rejects.toThrow(/draft/);
    expect(mappingsOf("draft-1")).toEqual(OLD_MAPPINGS);
  });

  it.each([
    ["missing mappings", undefined],
    ["mappings that are not a list", { csvColumn: "Datum" }],
    ["a mapping without a column", [{ targetField: "date", confidence: 1, userConfirmed: true, keepAsMetadata: false }]],
    ["a mapping with an unknown field", [{ ...MAPPINGS[0], userId: "intruder" }]],
    ["a mapping to an unknown target field", [{ ...MAPPINGS[0], targetField: "userId" }]],
  ])("refuses %s and writes nothing", async (_name, fieldMappings) => {
    await expect(
      run(createTestContext(USER), { importJobId: "job-1", sourceId: "s1", fieldMappings, rows: [row("t1")] })
    ).rejects.toThrow();
    expect(mappingsOf("job-1")).toEqual(OLD_MAPPINGS);
    expect((store.getDoc("transactions", "t1") as { name: string }).name).toBe("old");
  });

  it("rewrites the transaction and computes the dedupe hash on the server", async () => {
    const result = await run(createTestContext(USER), { importJobId: "job-1", sourceId: "s1", fieldMappings: MAPPINGS, rows: [row("t1")] });

    expect(result).toMatchObject({ updated: 1, skipped: 0 });
    const stored = store.getDoc("transactions", "t1") as Record<string, unknown>;
    expect(stored).toMatchObject({ name: "REWE", amount: -2390, partner: "REWE", reference: "Einkauf 7", currency: "EUR" });
    expect(stored.dedupeHash).toBe(
      computeDedupeHash({ date: "2026-09-03T00:00:00.000Z", amount: -2390, sourceIdentifier: "AT12 3456", reference: "Einkauf 7" })
    );
  });

  it("uses the source id as identifier for an account without an IBAN", async () => {
    store.setDoc("sources", "card", createTestSource({ userId: USER, currency: "EUR", iban: undefined }));
    store.setDoc("transactions", "t-card", { userId: USER, importJobId: "card-job" });
    await run(createTestContext(USER), { importJobId: "card-job", sourceId: "card", fieldMappings: MAPPINGS, rows: [row("t-card")] });
    const stored = store.getDoc("transactions", "t-card") as { dedupeHash: string };
    expect(stored.dedupeHash).toBe(
      computeDedupeHash({ date: "2026-09-03", amount: -2390, sourceIdentifier: "card", reference: "Einkauf 7" })
    );
  });

  it("never touches another user's transaction, another import's, or a missing one", async () => {
    const result = await run(createTestContext(USER), {
      importJobId: "job-1",
      sourceId: "s1",
      fieldMappings: MAPPINGS,
      rows: [row("t-other-user"), row("t-other-import"), row("nope"), row("t1")],
    });
    expect(result).toMatchObject({ updated: 1, skipped: 3 });
    expect((store.getDoc("transactions", "t-other-user") as { name: string }).name).toBe("keep");
    expect((store.getDoc("transactions", "t-other-import") as { name: string }).name).toBe("keep");
  });

  it("refuses a source that is not the caller's", async () => {
    await expect(run(createTestContext("intruder"), { importJobId: "job-1", sourceId: "s1", fieldMappings: MAPPINGS, rows: [row("t1")] })).rejects.toThrow(/denied/);
    expect((store.getDoc("transactions", "t1") as { name: string }).name).toBe("old");
  });

  it.each([
    ["a non-integer amount", row("t1", { amount: 12.5 })],
    ["an invalid date", row("t1", { date: "yesterday" })],
    ["a missing transaction id", row("", {})],
  ])("rejects %s before writing anything", async (_name, bad) => {
    await expect(run(createTestContext(USER), { importJobId: "job-1", sourceId: "s1", fieldMappings: MAPPINGS, rows: [row("t1"), bad] })).rejects.toThrow();
    expect((store.getDoc("transactions", "t1") as { name: string }).name).toBe("old");
  });

  it("rejects an oversized request", async () => {
    const many = Array.from({ length: 5001 }, (_, i) => row(`t${i}`));
    await expect(run(createTestContext(USER), { importJobId: "job-1", sourceId: "s1", fieldMappings: MAPPINGS, rows: many })).rejects.toThrow(/5000/);
  });
});
