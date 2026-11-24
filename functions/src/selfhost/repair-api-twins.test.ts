/**
 * #685, the repair end to end on the self-host database: per User and Bank
 * Account, each API twin's File Connections, Partner and completion move onto
 * its CSV row through the writers, then the API row goes. A dry run writes
 * nothing; a pair that needs a decision or a move the writer refuses is
 * reported and left as it is; a second run finds nothing to do.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";

// REAL application code, unmodified:
import "../invoicing/onFileConnectionWrite";
import { repairApiTwins, surveyApiTwins } from "../transactions/repairApiTwins";
import { connectFiles } from "../fileConnections/writer";

const db = getFirestore();
const ME = "twins-me";
const OTHER = "twins-other";
const SRC = "src-giro";
const API = "api_1750000000001";
const CSV = "import_1755000000000_abc1234";
const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));
const JUNE = Timestamp.fromDate(new Date("2026-06-16T10:00:00Z"));
const AUG = Timestamp.fromDate(new Date("2026-08-13T10:00:00Z"));

async function seedTx(id: string, importJobId: string, date: string, amount: number, extra: Record<string, unknown> = {}) {
  await db.collection("transactions").doc(id).set({
    userId: ME,
    sourceId: SRC,
    importJobId,
    date: day(date),
    amount,
    name: "CARD PAYMENT",
    fileIds: [],
    isComplete: false,
    createdAt: importJobId === API ? JUNE : AUG,
    ...extra,
  });
}

async function seedFile(id: string, extra: Record<string, unknown> = {}) {
  await db.collection("files").doc(id).set({
    userId: ME,
    fileName: `${id}.pdf`,
    fileType: "application/pdf",
    extractionComplete: true,
    transactionIds: [],
    ...extra,
  });
}

/** A File Connection as the old MCP tool wrote it: a random id, no origin. */
async function seedLegacyConnection(fileId: string, transactionId: string) {
  await db.collection("files").doc(fileId).update({ transactionIds: [transactionId] });
  await db.collection("transactions").doc(transactionId).update({ fileIds: [fileId], isComplete: true });
  await db.collection("fileConnections").doc(`legacy-${fileId}`).set({
    userId: ME,
    fileId,
    transactionId,
    connectionType: "api",
    matchConfidence: 0,
    createdAt: JUNE,
  });
}

async function seed() {
  await db.collection("sources").doc(SRC).set({ userId: ME, name: "Giro", iban: "AT000000000000000000" });
  await db.collection("imports").doc(CSV).set({ userId: ME, sourceId: SRC, status: "completed" });
  await db.collection("partners").doc("p-shop").set({ userId: ME, name: "Shop" });
  await db
    .collection("subscriptions")
    .doc(ME)
    .set({ userId: ME, plan: "pro", transactionCountCurrentMonth: 10, transactionCountMonth: "2026-06" });

  // A clean pair: the Partner sits on the API twin only.
  await seedTx("a-clean", API, "2026-03-02", -1999, { partnerId: "p-shop", partnerType: "user", partnerMatchedBy: "manual" });
  await seedTx("c-clean", CSV, "2026-03-02", -1999, { name: "Card payment" });
  // The File Connection sits on the API twin only.
  await seedTx("a-file", API, "2026-03-05", -4200);
  await seedTx("c-file", CSV, "2026-03-05", -4200);
  await seedFile("f-receipt");
  await seedLegacyConnection("f-receipt", "a-file");
  // Each twin holds a different File.
  await seedTx("a-two", API, "2026-04-01", -1000);
  await seedTx("c-two", CSV, "2026-04-01", -1000);
  await seedFile("f-api");
  await seedFile("f-csv");
  await seedLegacyConnection("f-api", "a-two");
  await seedLegacyConnection("f-csv", "c-two");
  // The File on the API twin is a Copy: the writer refuses to connect it.
  await seedTx("a-copy", API, "2026-04-03", -700);
  await seedTx("c-copy", CSV, "2026-04-03", -700);
  await seedFile("f-original");
  await seedFile("f-copy");
  await seedLegacyConnection("f-copy", "a-copy");
  await db.collection("files").doc("f-copy").update({ copyOfFileId: "f-original" });
  // A CSV row with no twin, and an API row with none.
  await seedTx("c-alone", CSV, "2026-01-10", -300);
  await seedTx("a-alone", API, "2026-05-20", -800);
  await drainTriggers();
}

async function tx(id: string) {
  const snap = await db.collection("transactions").doc(id).get();
  return snap.exists ? snap.data()! : null;
}

async function recordsOf(fileId: string) {
  return (await db.collection("fileConnections").where("userId", "==", ME).where("fileId", "==", fileId).get()).docs.map(
    (d) => d.data()
  );
}

async function sourceTotal(from: string, to: string) {
  const snap = await db.collection("transactions").where("userId", "==", ME).where("sourceId", "==", SRC).get();
  return snap.docs
    .map((d) => d.data())
    .filter((t) => {
      const d = (t.date as Timestamp).toDate().toISOString().slice(0, 10);
      return d >= from && d <= to;
    })
    .reduce((sum, t) => sum + (t.amount as number), 0);
}

/**
 * A dry run, then (with `apply`) the apply of exactly what it listed, as an
 * operator runs it. No trigger is drained: a script process dispatches none.
 */
async function run(apply: boolean) {
  const dry = await repairApiTwins(db, { userId: ME, sourceId: SRC, apply: false });
  if (!apply) return dry;
  const report = await repairApiTwins(db, { userId: ME, sourceId: SRC, apply: true, reviewed: JSON.parse(JSON.stringify(dry.merges)) });
  await __whenShimIdle();
  return report;
}

const COLLECTIONS = ["transactions", "files", "fileConnections", "invoices", "subscriptions", "partners", "noReceiptCategories", "imports"];
async function dump() {
  const out: Record<string, unknown> = {};
  for (const c of COLLECTIONS) {
    out[c] = (await db.collection(c).get()).docs.map((d) => [d.id, d.data()]).sort();
  }
  return JSON.parse(JSON.stringify(out));
}

beforeEach(async () => {
  await __resetFirestoreShim();
  __resetTriggerShim();
  await seed();
});

describe("repairing API twins", () => {
  it("reports every pair on a dry run", async () => {
    const report = await run(false);
    expect(report.merges.map((m) => [m.apiId, m.csvId, m.done])).toEqual([
      ["a-clean", "c-clean", false],
      ["a-file", "c-file", false],
    ]);
    expect(report.decisions).toEqual([expect.objectContaining({ apiId: "a-two", reason: "different-files" })]);
    expect(report.blocked).toEqual([expect.objectContaining({ apiId: "a-copy", reason: "copy", fileId: "f-copy" })]);
    expect(report.unmatched).toEqual(["a-alone"]);
    expect(report.legacyImports).toEqual({ [API]: 5 });
  });

  it("changes no stored record on a dry run", async () => {
    const before = await dump();
    await run(false);
    expect(await dump()).toEqual(before);
  });

  it("moves a clean pair's Partner onto the CSV row and removes the API row", async () => {
    const report = await run(true);
    expect(report.merges.find((m) => m.apiId === "a-clean")).toMatchObject({ done: true });
    expect(await tx("a-clean")).toBeNull();
    expect(await tx("c-clean")).toMatchObject({ partnerId: "p-shop", partnerType: "user", partnerMatchedBy: "manual" });
  });

  it("moves a File Connection only the API twin holds, once, with its origin kept", async () => {
    await run(true);
    expect(await tx("a-file")).toBeNull();
    const records = await recordsOf("f-receipt");
    expect(records).toEqual([
      expect.objectContaining({ transactionId: "c-file", origin: "mcp", connectionType: "api", matchConfidence: 0 }),
    ]);
    expect((await db.collection("files").doc("f-receipt").get()).data()!.transactionIds).toEqual(["c-file"]);
    expect(await tx("c-file")).toMatchObject({ fileIds: ["f-receipt"], isComplete: true });
  });

  it("keeps an invoice paid when its File moves: by the CSV row now", async () => {
    await db.collection("invoices").doc("inv-1").set({ userId: ME, status: "paid", paidByTransactionId: "a-file" });
    await db.collection("files").doc("f-receipt").update({ invoiceId: "inv-1" });
    const report = await run(true);
    expect(report.merges.find((m) => m.apiId === "a-file")!.invoiceFileIds).toEqual(["f-receipt"]);
    expect((await db.collection("invoices").doc("inv-1").get()).data()).toMatchObject({
      status: "paid",
      paidByTransactionId: "c-file",
    });
  });

  it("moves a No-document Category and keeps its count at one per bank line", async () => {
    await db.collection("noReceiptCategories").doc("k-fees").set({ userId: ME, name: "Bank fees", transactionCount: 1 });
    await db.collection("transactions").doc("a-clean").update({
      noReceiptCategoryId: "k-fees", noReceiptCategoryMatchedBy: "manual", noReceiptCategoryConfidence: 100, isComplete: true,
    });
    await run(true);
    expect(await tx("c-clean")).toMatchObject({ noReceiptCategoryId: "k-fees", noReceiptCategoryMatchedBy: "manual", isComplete: true });
    expect((await db.collection("noReceiptCategories").doc("k-fees").get()).data()!.transactionCount).toBe(1);
  });

  it("leaves a pair whose twins hold different Files unchanged", async () => {
    await run(true);
    expect(await tx("a-two")).toMatchObject({ fileIds: ["f-api"] });
    expect(await tx("c-two")).toMatchObject({ fileIds: ["f-csv"] });
    expect(await recordsOf("f-api")).toEqual([expect.objectContaining({ transactionId: "a-two" })]);
  });

  it("leaves a pair unchanged when the writer would refuse the move", async () => {
    const report = await run(true);
    expect(report.blocked).toEqual([expect.objectContaining({ apiId: "a-copy", reason: "copy" })]);
    expect(await tx("a-copy")).toMatchObject({ fileIds: ["f-copy"] });
    expect(await tx("c-copy")).toMatchObject({ fileIds: [] });
    expect(await recordsOf("f-copy")).toEqual([expect.objectContaining({ transactionId: "a-copy" })]);
  });

  it("counts each bank line once afterwards, and takes the twin off the month it was counted in", async () => {
    const before = await sourceTotal("2026-02-01", "2026-06-30");
    await run(true);
    // The two merged API rows are gone: -1999 and -4200 counted once.
    expect(await sourceTotal("2026-02-01", "2026-06-30")).toBe(before + 1999 + 4200);
    expect((await db.collection("subscriptions").doc(ME).get()).data()!.transactionCountCurrentMonth).toBe(8);
  });

  it("does nothing on a second run", async () => {
    await run(true);
    const second = await run(true);
    expect(second.merges).toEqual([]);
    expect(second.decisions.map((d) => d.apiId)).toEqual(["a-two"]);
    expect(second.blocked.map((b) => b.apiId)).toEqual(["a-copy"]);
    expect(second.failed).toEqual([]);
  });

  it("only unlinks a File both twins hold, then removes the API row", async () => {
    await seedTx("a-both", API, "2026-05-02", -900);
    await seedTx("c-both", CSV, "2026-05-02", -900);
    await seedFile("f-both");
    await connectFiles(db, ME, [{ fileId: "f-both", transactionId: "a-both" }, { fileId: "f-both", transactionId: "c-both" }], { origin: "manual" });
    const report = await run(true);
    expect(report.merges.find((m) => m.apiId === "a-both")).toMatchObject({ moves: [], unlinkOnly: ["f-both"], done: true });
    expect(await tx("a-both")).toBeNull();
    expect(await recordsOf("f-both")).toEqual([expect.objectContaining({ transactionId: "c-both", origin: "manual" })]);
    expect((await db.collection("files").doc("f-both").get()).data()!.transactionIds).toEqual(["c-both"]);
  });

  it("gives a CSV row over quota its counted twin's slot, without counting the line again", async () => {
    await db.collection("transactions").doc("c-file").update({ quotaExceeded: true });
    const report = await run(true);
    expect(report.merges.find((m) => m.apiId === "a-file")).toMatchObject({ quota: "transfer", done: true });
    expect(await tx("c-file")).toMatchObject({ quotaExceeded: false, fileIds: ["f-receipt"] });
    // Only the clean pair's line was counted twice.
    expect((await db.collection("subscriptions").doc(ME).get()).data()!.transactionCountCurrentMonth).toBe(9);
  });

  it("leaves the count alone once it is a later month than the twin's import", async () => {
    await db.collection("subscriptions").doc(ME).update({ transactionCountMonth: "2026-11", transactionCountCurrentMonth: 3 });
    await run(true);
    expect((await db.collection("subscriptions").doc(ME).get()).data()!.transactionCountCurrentMonth).toBe(3);
  });

  it("applies only what the reviewed dry run listed, as it listed it", async () => {
    const dry = await repairApiTwins(db, { userId: ME, sourceId: SRC, apply: false });
    const reviewed = dry.merges.filter((m) => m.apiId === "a-file");
    // The clean pair changes after the review: the CSV row gets a File.
    const report = await repairApiTwins(db, { userId: ME, sourceId: SRC, apply: true, reviewed: [...reviewed, { ...dry.merges[0], quota: "none" }] });
    expect(report.merges.map((m) => m.apiId)).toEqual(["a-file"]);
    expect(report.skipped).toEqual([
      { apiId: "a-clean", csvId: "c-clean", reason: "planned differently than in the reviewed dry run" },
    ]);
    expect(await tx("a-clean")).not.toBeNull();
    const none = await repairApiTwins(db, { userId: ME, sourceId: SRC, apply: true });
    expect(none.merges).toEqual([]);
    expect(none.skipped.map((s) => s.reason)).toEqual(["not in the reviewed dry run"]);
  });

  it("skips a pair that changed between its read and its merge", async () => {
    const dry = await repairApiTwins(db, { userId: ME, sourceId: SRC, apply: false });
    const report = await repairApiTwins(db, {
      userId: ME,
      sourceId: SRC,
      apply: true,
      reviewed: dry.merges,
      beforeChange: async () => {
        await db.collection("transactions").doc("c-clean").update({ partnerId: "p-other" });
      },
    });
    expect(report.skipped).toEqual([{ apiId: "a-clean", csvId: "c-clean", reason: "the pair changed since it was read" }]);
    expect(await tx("a-clean")).not.toBeNull();
  });

  it("backs up the rows, records, Files, invoices and counts it may change", async () => {
    await db.collection("invoices").doc("inv-1").set({ userId: ME, status: "paid", paidByTransactionId: "a-file" });
    await db.collection("files").doc("f-receipt").update({ invoiceId: "inv-1" });
    const dry = await repairApiTwins(db, { userId: ME, sourceId: SRC, apply: false });
    let backup: Record<string, Array<{ id: string }> | { id: string } | null> = {};
    await repairApiTwins(db, {
      userId: ME, sourceId: SRC, apply: true, reviewed: dry.merges,
      beforeChange: async (b) => {
        backup = b as never;
      },
    });
    const ids = (k: string) => (backup[k] as Array<{ id: string }>).map((d) => d.id).sort();
    expect(ids("transactions")).toEqual(["a-clean", "a-file", "c-clean", "c-file"]);
    expect(ids("fileConnections")).toEqual(["legacy-f-receipt"]);
    expect(ids("files")).toEqual(["f-receipt"]);
    expect(ids("invoices")).toEqual(["inv-1"]);
    expect(ids("partners")).toEqual(["p-shop"]);
    expect((backup.subscription as { id: string }).id).toBe(ME);
  });

  it("moves records of the automatic and accepted-suggestion origins with their origin", async () => {
    await seedTx("a-auto", API, "2026-05-05", -1500);
    await seedTx("c-auto", CSV, "2026-05-05", -1500);
    await seedFile("f-auto");
    await seedFile("f-sugg", { transactionSuggestions: [{ transactionId: "c-auto", confidence: 77, matchSources: ["amount"] }] });
    await db.collection("transactions").doc("a-auto").update({ fileIds: ["f-auto", "f-sugg"], isComplete: true });
    await db.collection("files").doc("f-auto").update({ transactionIds: ["a-auto"] });
    await db.collection("files").doc("f-sugg").update({ transactionIds: ["a-auto"] });
    await db.collection("fileConnections").doc("r-auto").set({
      userId: ME, fileId: "f-auto", transactionId: "a-auto", connectionType: "auto_matched", matchConfidence: 93, createdAt: JUNE,
    });
    await db.collection("fileConnections").doc("r-sugg").set({
      userId: ME, fileId: "f-sugg", transactionId: "a-auto", origin: "suggestion", connectionType: "suggestion_accepted", matchConfidence: 60, createdAt: JUNE,
    });
    const report = await run(true);
    expect(report.merges.find((m) => m.apiId === "a-auto")!.moves.map((m) => [m.fileId, m.origin, m.dropped])).toEqual([
      ["f-auto", "auto", ["createdAt"]],
      ["f-sugg", "suggestion", ["createdAt", "matchConfidence"]],
    ]);
    expect(await recordsOf("f-auto")).toEqual([
      expect.objectContaining({ transactionId: "c-auto", origin: "auto", connectionType: "auto_matched", matchConfidence: 93 }),
    ]);
    // An accepted suggestion takes the confidence the server reads: the File's stored one.
    expect(await recordsOf("f-sugg")).toEqual([
      expect.objectContaining({ transactionId: "c-auto", origin: "suggestion", connectionType: "suggestion_accepted", matchConfidence: 77 }),
    ]);
  });

  it("never touches another User's rows", async () => {
    await db.collection("transactions").doc("a-foreign").set({
      userId: OTHER, sourceId: SRC, importJobId: API, date: day("2026-03-02"), amount: -1999, name: "CARD PAYMENT", fileIds: [],
    });
    const report = await run(true);
    expect(report.merges.map((m) => m.apiId)).not.toContain("a-foreign");
    expect(await tx("a-foreign")).not.toBeNull();
  });
});

describe("surveying every account, read-only", () => {
  it("lists each account whose old API import overlaps a CSV import, and writes nothing", async () => {
    await db.collection("transactions").doc("o-api").set({
      userId: OTHER, sourceId: "src-o", importJobId: "api_1751111111111", date: day("2026-02-02"), amount: -100, name: "X", fileIds: [],
    });
    await db.collection("imports").doc("import_1").set({ userId: OTHER, sourceId: "src-o", status: "completed" });
    await db.collection("transactions").doc("o-csv").set({
      userId: OTHER, sourceId: "src-o", importJobId: "import_1", date: day("2026-02-02"), amount: -100, name: "X", fileIds: [],
    });
    // The current tool's id format was deduplicated: not listed.
    await db.collection("transactions").doc("n-api").set({
      userId: OTHER, sourceId: "src-n", importJobId: "api_1751111111111_ab12cd34", date: day("2026-02-02"), amount: -100, name: "X", fileIds: [],
    });
    const survey = await surveyApiTwins(db);
    expect(survey.accounts).toEqual([
      { userId: ME, sourceId: SRC, legacyImports: { [API]: 5 }, apiRows: 5, paired: 4, ambiguous: 0, unmatched: 1 },
      { userId: OTHER, sourceId: "src-o", legacyImports: { api_1751111111111: 1 }, apiRows: 1, paired: 1, ambiguous: 0, unmatched: 0 },
    ]);
    expect(await tx("a-clean")).not.toBeNull();
  });
});
