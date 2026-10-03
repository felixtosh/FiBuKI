/**
 * #590: the hint removal pass runs against the REAL Postgres-backed shim (no
 * mocks), so the deletes land in the self-host store and the review list is
 * read from the same records the precision search writes.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { removeLocalFileHints } from "./migrate-remove-local-file-hints";

const db = getFirestore();

const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00.000Z`));

async function tmpOutDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "local-file-hints-"));
}

function hint(transactionId: string, searchStrategy: string) {
  return {
    transactionId,
    transactionAmount: -1990,
    transactionDate: day("2026-03-01"),
    searchStrategy,
    matchConfidence: 65,
    searchedAt: day("2026-03-02"),
  };
}

async function file(id: string, extra: Record<string, unknown> = {}) {
  await db.collection("files").doc(id).set({ userId: "u1", fileName: `${id}.pdf`, ...extra });
}

async function transaction(id: string, date = "2026-03-01") {
  await db.collection("transactions").doc(id).set({
    userId: "u1",
    date: day(date),
    amount: -1990,
    currency: "EUR",
    name: `Charge ${id}`,
    partner: "Netflix",
  });
}

async function connection(id: string, fileId: string, transactionId: string, connectionType = "auto_matched") {
  await db.collection("fileConnections").doc(id).set({
    userId: "u1",
    fileId,
    transactionId,
    connectionType,
    matchSources: ["partner", "date", "precision_hint"],
    matchConfidence: 87,
    createdAt: day("2026-03-03"),
  });
}

async function search(transactionId: string, strategy: string, fileIds: string[], startedAt = "2026-03-02") {
  await db
    .collection("transactions")
    .doc(transactionId)
    .collection("searches")
    .add({
      triggeredBy: "import",
      precisionSearchQueueId: `q-${transactionId}-${strategy}`,
      strategiesAttempted: [strategy],
      automationSource: fileIds.length > 0 ? strategy : null,
      attempts: [
        {
          strategy,
          startedAt: day(startedAt),
          searchParams: {},
          candidatesFound: fileIds.length,
          candidatesEvaluated: fileIds.length,
          matchesFound: fileIds.length,
          fileIdsConnected: fileIds,
        },
      ],
    });
}

/**
 * One case of each kind:
 *   fP  Partner-strategy hint, auto-connected on it        → hint removed, listed
 *   fA  amount-strategy hint, auto-connected on it         → hint removed, listed
 *   fE  email-strategy hint, auto-connected on it          → hint kept, not listed
 *   fN  auto-connected by the matcher, never hinted        → not listed
 *   fM  Partner-strategy hint, but connected by a person   → hint removed, not listed
 *   fX  Partner-strategy hint for tP2, connected to tX     → not listed (other pair)
 *   fO  Partner hint for tO since overwritten by an email
 *       hint for tE2, still connected to tO                → hint kept, listed
 */
async function seed() {
  for (const t of ["tP", "tA", "tE", "tN", "tM", "tP2", "tX", "tO", "tE2"]) await transaction(t);

  await file("fP", { precisionSearchHint: hint("tP", "partner_files") });
  await search("tP", "partner_files", ["fP"]);
  await connection("cP", "fP", "tP");

  await file("fA", { precisionSearchHint: hint("tA", "amount_files") });
  await search("tA", "amount_files", ["fA"]);
  await connection("cA", "fA", "tA");

  await file("fE", { precisionSearchHint: hint("tE", "email_attachment") });
  await search("tE", "email_attachment", ["fE"]);
  await connection("cE", "fE", "tE");

  await file("fN");
  await connection("cN", "fN", "tN");

  await file("fM", { precisionSearchHint: hint("tM", "partner_files") });
  await search("tM", "partner_files", ["fM"]);
  await connection("cM", "fM", "tM", "manual");

  await file("fX", { precisionSearchHint: hint("tP2", "partner_files") });
  await search("tP2", "partner_files", ["fX"]);
  await connection("cX", "fX", "tX");

  await file("fO", { precisionSearchHint: hint("tE2", "email_invoice") });
  await search("tO", "partner_files", ["fO"]);
  await search("tE2", "email_invoice", ["fO"]);
  await connection("cO", "fO", "tO");
}

async function hintOf(fileId: string) {
  return (await db.collection("files").doc(fileId).get()).data()!.precisionSearchHint;
}

async function connectionIds() {
  return (await db.collection("fileConnections").get()).docs.map((d) => d.id).sort();
}

beforeEach(async () => {
  await __resetFirestoreShim();
});

describe("removeLocalFileHints", () => {
  it("removes the Partner and amount hints and keeps the email ones", async () => {
    await seed();

    const report = await removeLocalFileHints({ apply: true, outDir: await tmpOutDir(), log: () => {} });

    expect(report.hintsRemoved.map((h) => h.fileId).sort()).toEqual(["fA", "fM", "fP", "fX"]);
    expect(report.hintsKept).toBe(2);
    for (const id of ["fA", "fM", "fP", "fX"]) expect(await hintOf(id)).toBeUndefined();
    expect(await hintOf("fE")).toMatchObject({ transactionId: "tE", searchStrategy: "email_attachment" });
    expect(await hintOf("fO")).toMatchObject({ transactionId: "tE2", searchStrategy: "email_invoice" });

    // The rest of the File is untouched.
    expect((await db.collection("files").doc("fP").get()).data()).toEqual({ userId: "u1", fileName: "fP.pdf" });
  });

  it("lists exactly the File Connections the two strategies made", async () => {
    await seed();

    const report = await removeLocalFileHints({ apply: true, outDir: await tmpOutDir(), log: () => {} });

    expect(report.connectionsToReview.map((c) => c.connectionId).sort()).toEqual(["cA", "cO", "cP"]);
    expect(report.connectionsToReview.find((c) => c.connectionId === "cP")).toEqual({
      connectionId: "cP",
      userId: "u1",
      fileId: "fP",
      fileName: "fP.pdf",
      transactionId: "tP",
      transactionDate: "2026-03-01",
      transactionAmount: -1990,
      transactionCurrency: "EUR",
      transactionName: "Charge tP",
      transactionPartner: "Netflix",
      strategies: ["partner_files"],
      connectedAt: "2026-03-03T00:00:00.000Z",
      matchConfidence: 87,
    });

    const csv = await fs.readFile(report.listPath, "utf8");
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(
      "connectedAt,matchConfidence,strategies,fileName,transactionDate,transactionAmount," +
        "transactionCurrency,transactionName,transactionPartner,userId,fileId,transactionId,connectionId",
    );
    expect(lines).toHaveLength(4);
    expect(lines).toContain(
      "2026-03-03T00:00:00.000Z,87,partner_files,fP.pdf,2026-03-01,-1990,EUR,Charge tP,Netflix,u1,fP,tP,cP",
    );
  });

  it("disconnects nothing and changes no File Connection", async () => {
    await seed();
    const before = (await db.collection("fileConnections").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
    const txBefore = (await db.collection("transactions").get()).docs.map((d) => ({ id: d.id, ...d.data() }));

    await removeLocalFileHints({ apply: true, outDir: await tmpOutDir(), log: () => {} });

    const after = (await db.collection("fileConnections").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
    const txAfter = (await db.collection("transactions").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
    expect(after).toEqual(before);
    expect(txAfter).toEqual(txBefore);
    expect(await connectionIds()).toEqual(["cA", "cE", "cM", "cN", "cO", "cP", "cX"]);
  });

  it("is safe to run twice: the second run removes nothing and lists the same connections", async () => {
    await seed();
    const outDir = await tmpOutDir();

    const first = await removeLocalFileHints({ apply: true, outDir, log: () => {} });
    const second = await removeLocalFileHints({ apply: true, outDir, log: () => {} });

    expect(first.hintsRemoved).toHaveLength(4);
    expect(second.hintsRemoved).toHaveLength(0);
    expect(second.backupPath).toBeNull();
    expect(second.connectionsToReview).toEqual(first.connectionsToReview);
  });

  it("backs up every removed hint before deleting it", async () => {
    await seed();

    const report = await removeLocalFileHints({ apply: true, outDir: await tmpOutDir(), log: () => {} });

    const backup = JSON.parse(await fs.readFile(report.backupPath!, "utf8"));
    expect(backup.map((e: { fileId: string }) => e.fileId).sort()).toEqual(["fA", "fM", "fP", "fX"]);
    expect(backup.find((e: { fileId: string }) => e.fileId === "fP")).toMatchObject({
      userId: "u1",
      precisionSearchHint: { transactionId: "tP", searchStrategy: "partner_files", matchConfidence: 65 },
    });
  });

  it("dry run lists the connections and writes no hint removal", async () => {
    await seed();
    const outDir = await tmpOutDir();

    const report = await removeLocalFileHints({ apply: false, outDir, log: () => {} });

    expect(report.hintsRemoved).toHaveLength(4);
    expect(report.backupPath).toBeNull();
    expect(report.connectionsToReview).toHaveLength(3);
    expect(await hintOf("fP")).toMatchObject({ searchStrategy: "partner_files" });
    expect(await fs.readdir(outDir)).toEqual([path.basename(report.listPath)]);
  });

  it("keeps a mailbox file name from running as a spreadsheet formula", async () => {
    await transaction("tF");
    await file("fF", { fileName: '=HYPERLINK("x","invoice, March")' });
    await search("tF", "partner_files", ["fF"]);
    await connection("cF", "fF", "tF");

    const report = await removeLocalFileHints({ apply: false, outDir: await tmpOutDir(), log: () => {} });

    const row = (await fs.readFile(report.listPath, "utf8")).trim().split("\n")[1];
    expect(row).toContain(`"'=HYPERLINK(""x"",""invoice, March"")"`);
    expect(row).toContain(",-1990,");
  });

  /**
   * After #589 an attempt names a strategy only for a connection the matcher
   * made on a zero-point nomination. Bounded by the deploy time, it is left out.
   */
  it("reads only the attempts started before `until`", async () => {
    await transaction("tLate");
    await file("fLate");
    await search("tLate", "partner_files", ["fLate"], "2026-05-02");
    await connection("cLate", "fLate", "tLate");
    await transaction("tEarly");
    await file("fEarly");
    await search("tEarly", "amount_files", ["fEarly"], "2026-04-02");
    await connection("cEarly", "fEarly", "tEarly");

    const report = await removeLocalFileHints({
      apply: true,
      outDir: await tmpOutDir(),
      until: new Date("2026-05-01T00:00:00.000Z"),
      log: () => {},
    });

    expect(report.connectionsToReview.map((c) => c.connectionId)).toEqual(["cEarly"]);
  });
});
