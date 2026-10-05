/**
 * The one writer of File Connections (#612), tested at its interface: every
 * rule the Connection Origin decides, for every origin, and the guarantees the
 * three records owe each other whoever writes them.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";

// REAL application code, unmodified:
import "../invoicing/onFileConnectionWrite";
import { connectFiles, unlinkFile, type ConnectOutcome } from "../fileConnections/writer";
import { CONNECTION_ORIGINS, connectionDocId, type ConnectionOrigin } from "../fileConnections/rules";
import { connectFileToTransactionCallable } from "../files/connectFileToTransaction";
import { deleteTransactionsBySourceCallable } from "../transactions/deleteTransactionsBySource";
import { deleteImportRecordCallable } from "../imports/deleteImportRecord";
import { deleteSourceCallable } from "../sources/deleteSource";
import { matchFilesForPartnerInternal } from "../matching/matchFilesForPartner";
import { markFileAsCopyCallable } from "../files/copyCallables";
import * as billingCycle from "../matching/learnBillingCycle";
import * as partnerProvenance from "../matching/partnerProvenance";
import { performDeleteFile } from "../files/deleteFile";

const db = getFirestore();
const ME = "writer-me";
const DAY = Timestamp.fromDate(new Date("2026-09-10T00:00:00Z"));

type Callable = { run: (req: unknown) => Promise<unknown> };
function call<T>(fn: unknown, data: unknown, uid = ME): Promise<T> {
  return (fn as Callable).run({ data, auth: { uid, token: {} } }) as Promise<T>;
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

async function seedTx(id: string, extra: Record<string, unknown> = {}) {
  await db.collection("transactions").doc(id).set({
    userId: ME,
    amount: -4990,
    date: DAY,
    name: "HETZNER ONLINE",
    fileIds: [],
    ...extra,
  });
}

async function data(collection: string, id: string) {
  return (await db.collection(collection).doc(id).get()).data()!;
}

async function records(fileId?: string, transactionId?: string) {
  const snap = await db.collection("fileConnections").where("userId", "==", ME).get();
  return snap.docs.filter(
    (d) =>
      (fileId === undefined || d.data().fileId === fileId) &&
      (transactionId === undefined || d.data().transactionId === transactionId)
  );
}

function connect(origin: ConnectionOrigin, extra: { overrideRejection?: boolean } = {}, pair = { fileId: "f-1", transactionId: "t-1" }) {
  return connectFiles(db, ME, [pair], { origin, ...extra }).then(([o]) => o);
}

/** An accepted suggestion needs a stored one; every other origin ignores it. */
async function seedPair(fileExtra: Record<string, unknown> = {}, txExtra: Record<string, unknown> = {}) {
  await seedFile("f-1", {
    transactionSuggestions: [{ transactionId: "t-1", confidence: 72, matchSources: ["amount", "date"] }],
    ...fileExtra,
  });
  await seedTx("t-1", txExtra);
}

/** Whether the pair holds a File Connection: all three records agree. */
async function isConnected(fileId = "f-1", transactionId = "t-1") {
  const [file, tx, recs] = await Promise.all([data("files", fileId), data("transactions", transactionId), records(fileId, transactionId)]);
  const byFile = (file.transactionIds ?? []).includes(transactionId);
  const byTx = (tx.fileIds ?? []).includes(fileId);
  expect({ byFile, byTx, records: recs.length > 0 }).toEqual({ byFile, byTx: byFile, records: byFile });
  return byFile;
}

const DIRECTED: ConnectionOrigin[] = ["manual", "suggestion", "mcp", "agent"];
const IN_APP_CLICKS: ConnectionOrigin[] = ["manual", "suggestion"];

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
});

describe.each(CONNECTION_ORIGINS)("a connect with origin %s", (origin) => {
  it("connects a plain pair: one record under the pair's id, both lists, the activity entry", async () => {
    await seedPair();
    const outcome = await connect(origin);
    expect(outcome).toMatchObject({ status: "connected", connectionId: connectionDocId("f-1", "t-1") });
    expect(await isConnected()).toBe(true);
    const [record] = await records("f-1", "t-1");
    expect(record.id).toBe(connectionDocId("f-1", "t-1"));
    expect(record.data().origin).toBe(origin);
    const tx = await data("transactions", "t-1");
    expect(tx.isComplete).toBe(true);
    expect(tx.automationHistory.filter((e: { type: string }) => e.type === "file_connected")).toHaveLength(1);
  });

  it("refuses a Copy whose original is live (ADR-0010)", async () => {
    await seedFile("f-orig");
    await seedPair({ copyOfFileId: "f-orig" });
    expect(await connect(origin)).toMatchObject({ status: "refused", reason: "copy" });
    expect(await isConnected()).toBe(false);
  });

  it.each([["deleted", { deletedAt: DAY }], ["purged", { deletedAt: DAY, purgedAt: DAY }]])(
    "refuses a %s File",
    async (_label, extra) => {
      await seedPair(extra);
      expect(await connect(origin)).toMatchObject({ status: "refused", reason: "deleted" });
      expect(await isConnected()).toBe(false);
    }
  );

  const overQuota = IN_APP_CLICKS.includes(origin) ? "connects" : "refuses";
  it(`${overQuota} an over-quota Transaction`, async () => {
    await seedPair({}, { quotaExceeded: true });
    const outcome = await connect(origin);
    if (overQuota === "connects") {
      expect(outcome.status).toBe("connected");
    } else {
      expect(outcome).toMatchObject({ status: "refused", reason: "over-quota" });
    }
    expect(await isConnected()).toBe(overQuota === "connects");
  });

  const rejected = {
    dismissedTransactionIds: ["t-1"],
    dismissedTransactions: [{ transactionId: "t-1", dismissedAt: DAY, confidence: 60, reason: null }],
  };
  const lifts = origin === "manual";
  it(`${lifts ? "lifts" : "refuses"} a pair the File rejected`, async () => {
    await seedPair(rejected);
    const outcome = await connect(origin);
    if (lifts) {
      expect(outcome.status).toBe("connected");
      const file = await data("files", "f-1");
      expect(file.dismissedTransactionIds).toEqual([]);
      expect(file.dismissedTransactions[0].undismissedAt).toBeTruthy();
    } else {
      expect(outcome).toMatchObject({ status: "refused", reason: "rejected" });
      expect((await data("files", "f-1")).dismissedTransactionIds).toEqual(["t-1"]);
    }
    expect(await isConnected()).toBe(lifts);
  });

  it(`${lifts ? "lifts" : "refuses"} a pair the Transaction rejected`, async () => {
    await seedPair({}, { rejectedFileIds: ["f-1"], rejectedFiles: [{ fileId: "f-1", rejectedAt: DAY }] });
    const outcome = await connect(origin);
    expect(outcome.status).toBe(lifts ? "connected" : "refused");
    const tx = await data("transactions", "t-1");
    if (lifts) {
      expect(tx.rejectedFileIds).toEqual([]);
      expect(tx.rejectedFiles[0].unrejectedAt).toBeTruthy();
    } else {
      expect(tx.rejectedFileIds).toEqual(["f-1"]);
    }
  });

  const learns = DIRECTED.includes(origin) ? "directed" : "automated";
  it(`learns as ${learns === "directed" ? "a manual connect" : "automation: the email domain only"}`, async () => {
    const cycle = vi.spyOn(billingCycle, "learnBillingCycleForPartner").mockResolvedValue(null);
    await db.collection("partners").doc("p-1").set({ userId: ME, name: "Hetzner", emailDomains: [] });
    await seedPair({ gmailSenderDomain: "hetzner.com" }, { partnerId: "p-1", partnerType: "user" });
    await connectFiles(
      db,
      ME,
      [
        {
          fileId: "f-1",
          transactionId: "t-1",
          sourceInfo: { sourceType: "gmail", searchPattern: "from:hetzner rechnung", resultType: "gmail_attachment" },
        },
      ],
      { origin }
    );
    const partner = await data("partners", "p-1");
    expect(partner.emailDomains).toEqual(["hetzner.com"]);
    if (learns === "directed") {
      expect(partner.fileSourcePatterns.map((p: { pattern: string }) => p.pattern)).toEqual(["from:hetzner rechnung"]);
      expect(cycle).toHaveBeenCalledWith(expect.anything(), ME, "p-1");
    } else {
      expect(partner.fileSourcePatterns).toBeUndefined();
      expect(cycle).not.toHaveBeenCalled();
    }
    cycle.mockRestore();
  });
});

describe("the agent", () => {
  it("lifts a Rejection only when it says a human asked for the pair", async () => {
    await seedPair({ dismissedTransactionIds: ["t-1"], dismissedTransactions: [{ transactionId: "t-1", dismissedAt: DAY }] });
    expect(await connect("agent")).toMatchObject({ status: "refused", reason: "rejected" });
    expect(await connect("agent", { overrideRejection: true })).toMatchObject({ status: "connected" });
    expect((await data("files", "f-1")).dismissedTransactionIds).toEqual([]);
  });

  it("is refused an over-quota Transaction even when it labels the connect manual", async () => {
    await seedPair({}, { quotaExceeded: true });
    await expect(
      call(connectFileToTransactionCallable, { fileId: "f-1", transactionId: "t-1", origin: "agent", connectionType: "manual" })
    ).rejects.toMatchObject({ code: "failed-precondition" });
    expect(await isConnected()).toBe(false);
  });
});

describe("what counts as a Rejection", () => {
  it("the record shape alone holds, an undone record does not", async () => {
    await seedPair({ dismissedTransactions: [{ transactionId: "t-1", dismissedAt: DAY }] });
    expect(await connect("auto")).toMatchObject({ status: "refused", reason: "rejected" });
    await db.collection("files").doc("f-1").update({
      dismissedTransactions: [{ transactionId: "t-1", dismissedAt: DAY, undismissedAt: DAY }],
    });
    expect(await connect("auto")).toMatchObject({ status: "connected" });
  });

  it("a Rejection of another pair is left alone", async () => {
    await seedPair({ dismissedTransactionIds: ["t-other"], dismissedTransactions: [{ transactionId: "t-other", dismissedAt: DAY }] });
    expect(await connect("manual")).toMatchObject({ status: "connected" });
    expect((await data("files", "f-1")).dismissedTransactionIds).toEqual(["t-other"]);
  });
});

describe("replacing automated File Connections (the agent's receipt search)", () => {
  async function seedConnected(fileId: string, transactionId: string, connectionType: string) {
    await db.collection("fileConnections").doc(connectionDocId(fileId, transactionId)).set({ userId: ME, fileId, transactionId, connectionType });
  }

  it("takes the File's and the Transaction's automated Connections apart to make room", async () => {
    await seedFile("f-1", { transactionIds: ["t-old"] });
    await seedFile("f-old", { transactionIds: ["t-1"] });
    await seedTx("t-1", { fileIds: ["f-old"], isComplete: true });
    await seedTx("t-old", { fileIds: ["f-1"], isComplete: true });
    await seedConnected("f-1", "t-old", "auto_matched");
    await seedConnected("f-old", "t-1", "ai_matched");

    const [replaced] = await connectFiles(db, ME, [{ fileId: "f-1", transactionId: "t-1" }], { origin: "agent", replaceAutomated: true });
    expect(replaced).toMatchObject({ status: "connected", reassignedConnections: 2 });
    expect((await records()).map((r) => r.id)).toEqual([connectionDocId("f-1", "t-1")]);
    expect((await data("transactions", "t-1")).fileIds).toEqual(["f-1"]);
    expect((await data("files", "f-old")).transactionIds).toEqual([]);
    const old = await data("transactions", "t-old");
    expect(old.fileIds).toEqual([]);
    expect(old.isComplete).toBe(false);
  });

  it.each([
    ["the Transaction", "f-old", "t-1"],
    ["the File", "f-1", "t-old"],
  ])("refuses when %s holds a Connection a person made", async (_side, fileId, transactionId) => {
    await seedFile("f-1", { transactionIds: fileId === "f-1" ? ["t-old"] : [] });
    await seedFile("f-old", { transactionIds: fileId === "f-old" ? ["t-1"] : [] });
    await seedTx("t-1", { fileIds: transactionId === "t-1" ? ["f-old"] : [] });
    await seedTx("t-old", { fileIds: transactionId === "t-old" ? ["f-1"] : [] });
    await seedConnected(fileId, transactionId, "manual");
    const [outcome] = await connectFiles(db, ME, [{ fileId: "f-1", transactionId: "t-1" }], { origin: "agent", replaceAutomated: true });
    expect(outcome).toMatchObject({ status: "refused", reason: "locked" });
    expect(await records(fileId, transactionId)).toHaveLength(1);
  });
});

describe("one record per pair", () => {
  it("connecting a connected pair changes nothing and returns the existing File Connection", async () => {
    await seedPair();
    const first = await connect("manual");
    const again = await connect("auto");
    expect(again).toEqual({ fileId: "f-1", transactionId: "t-1", status: "already-connected", connectionId: (first as { connectionId: string }).connectionId });
    expect(await records()).toHaveLength(1);
    const tx = await data("transactions", "t-1");
    expect(tx.automationHistory.filter((e: { type: string }) => e.type === "file_connected")).toHaveLength(1);
  });

  it("two connects of the same pair at once leave exactly one record", async () => {
    await seedPair();
    const outcomes = await Promise.all([connect("manual"), connect("auto"), connect("mcp")]);
    expect(outcomes.filter((o) => o.status === "connected")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "already-connected")).toHaveLength(2);
    expect(await records()).toHaveLength(1);
    expect((await data("transactions", "t-1")).fileIds).toEqual(["f-1"]);
    expect((await data("files", "f-1")).transactionIds).toEqual(["t-1"]);
  });

  it("finds a record written before #612 under a random id", async () => {
    await seedPair({ transactionIds: ["t-1"] }, { fileIds: ["f-1"] });
    await db.collection("fileConnections").doc("legacy-random").set({ userId: ME, fileId: "f-1", transactionId: "t-1", createdAt: DAY });
    expect(await connect("manual")).toMatchObject({ status: "already-connected", connectionId: "legacy-random" });
    expect(await records()).toHaveLength(1);
  });

  it("a pair with two agreeing records answers already-connected and writes nothing", async () => {
    await seedPair({ transactionIds: ["t-1"] }, { fileIds: ["f-1"] });
    for (const id of ["dup-a", "dup-b"]) {
      await db.collection("fileConnections").doc(id).set({ userId: ME, fileId: "f-1", transactionId: "t-1", createdAt: DAY });
    }
    const before = [await data("files", "f-1"), await data("transactions", "t-1")];
    expect(await connect("manual")).toMatchObject({ status: "already-connected" });
    expect((await records()).map((d) => d.id).sort()).toEqual(["dup-a", "dup-b"]);
    expect([await data("files", "f-1"), await data("transactions", "t-1")]).toEqual(before);
  });

  it("Unlink removes every record of the pair, and both lists", async () => {
    await seedPair({ transactionIds: ["t-1"] }, { fileIds: ["f-1"], isComplete: true });
    for (const id of ["dup-a", "dup-b"]) {
      await db.collection("fileConnections").doc(id).set({ userId: ME, fileId: "f-1", transactionId: "t-1", createdAt: DAY });
    }
    const result = await unlinkFile(db, ME, { fileId: "f-1", transactionId: "t-1", reject: true });
    expect(result.removedRecords).toBe(2);
    expect(await records()).toHaveLength(0);
    expect(await isConnected()).toBe(false);
    const tx = await data("transactions", "t-1");
    expect(tx.isComplete).toBe(false);
    expect(tx.rejectedFileIds).toEqual(["f-1"]);
  });
});

// #642: a record whose lists do not both name the pair is no File Connection.
const DISAGREEING = [
  { shape: "orphan", fileLists: [] as string[], txLists: [] as string[] },
  { shape: "file-only", fileLists: ["t-1"], txLists: [] as string[] },
  { shape: "tx-only", fileLists: [] as string[], txLists: ["f-1"] },
];

describe.each(DISAGREEING)("a connect of a $shape pair (#642)", ({ fileLists, txLists }) => {
  async function seedDisagreeing(recordId: string, fileExtra: Record<string, unknown> = {}, txExtra: Record<string, unknown> = {}) {
    await seedPair({ transactionIds: fileLists, ...fileExtra }, { fileIds: txLists, ...txExtra });
    await db.collection("fileConnections").doc(recordId).set({ userId: ME, fileId: "f-1", transactionId: "t-1", connectionType: "manual", createdAt: DAY });
  }

  it.each(["legacy-random", connectionDocId("f-1", "t-1")])(
    "connects it: both lists, one record under the derived id (record %s)",
    async (recordId) => {
      await seedDisagreeing(recordId);
      expect(await connect("manual")).toMatchObject({ status: "connected", connectionId: connectionDocId("f-1", "t-1") });
      expect((await data("files", "f-1")).transactionIds).toEqual(["t-1"]);
      expect((await data("transactions", "t-1")).fileIds).toEqual(["f-1"]);
      const recs = await records();
      expect(recs.map((d) => d.id)).toEqual([connectionDocId("f-1", "t-1")]);
      expect(recs[0].data().origin).toBe("manual");
      const tx = await data("transactions", "t-1");
      expect(tx.isComplete).toBe(true);
      expect(tx.automationHistory.filter((e: { type: string }) => e.type === "file_connected")).toHaveLength(1);
    }
  );

  it("follows its origin's rules: an auto connect over quota is refused and changes nothing", async () => {
    await seedDisagreeing("legacy-random", {}, { quotaExceeded: true });
    const before = [await data("files", "f-1"), await data("transactions", "t-1")];
    expect(await connect("auto")).toMatchObject({ status: "refused", reason: "over-quota" });
    expect((await records()).map((d) => d.id)).toEqual(["legacy-random"]);
    expect([await data("files", "f-1"), await data("transactions", "t-1")]).toEqual(before);
  });

  it("leaves an invoice paid by the Transaction paid when the legacy record gives way to the derived one", async () => {
    await seedDisagreeing("legacy-random", { invoiceId: "inv-1" });
    // A revert followed by a re-pay would end `paid` too, with a new `paidAt`.
    await db.collection("invoices").doc("inv-1").set({ userId: ME, status: "paid", paidByTransactionId: "t-1", paidAt: DAY });
    await drainTriggers();
    expect(await connect("manual")).toMatchObject({ status: "connected" });
    await drainTriggers();
    expect((await records()).map((d) => d.id)).toEqual([connectionDocId("f-1", "t-1")]);
    const invoice = await data("invoices", "inv-1");
    expect(invoice).toMatchObject({ status: "paid", paidByTransactionId: "t-1" });
    expect(invoice.paidAt.toMillis()).toBe(DAY.toMillis());
  });

  it("keeps one record under the derived id when the pair has a legacy record beside it", async () => {
    await seedDisagreeing("dup-a");
    await db.collection("fileConnections").doc(connectionDocId("f-1", "t-1")).set({ userId: ME, fileId: "f-1", transactionId: "t-1", connectionType: "manual", createdAt: DAY });
    expect(await connect("manual")).toMatchObject({ status: "connected", connectionId: connectionDocId("f-1", "t-1") });
    expect((await records()).map((d) => d.id)).toEqual([connectionDocId("f-1", "t-1")]);
    expect((await data("files", "f-1")).transactionIds).toEqual(["t-1"]);
    expect((await data("transactions", "t-1")).fileIds).toEqual(["f-1"]);
  });
});

describe("an accepted suggestion", () => {
  it("records the stored Confidence and Match Sources, whatever the client sends", async () => {
    await seedPair();
    await call(connectFileToTransactionCallable, {
      fileId: "f-1",
      transactionId: "t-1",
      origin: "suggestion",
      matchConfidence: 99,
    });
    const [record] = await records("f-1", "t-1");
    expect(record.data()).toMatchObject({
      origin: "suggestion",
      connectionType: "suggestion_accepted",
      matchConfidence: 72,
      matchSources: ["amount", "date"],
      wasSuggested: true,
    });
    expect((await data("files", "f-1")).transactionSuggestions).toEqual([]);
  });

  it("is scored on the server when the File no longer stores the suggestion", async () => {
    await seedFile("f-1", { extractedAmount: 4990, extractedDate: DAY, extractedCurrency: "EUR" });
    await seedTx("t-1");
    await call(connectFileToTransactionCallable, { fileId: "f-1", transactionId: "t-1", origin: "suggestion", matchConfidence: 99 });
    const [record] = await records("f-1", "t-1");
    expect(record.data().matchConfidence).not.toBe(99);
    expect(typeof record.data().matchConfidence).toBe("number");
  });
});

describe("a list of pairs", () => {
  it("connects 500 pairs in one call", async () => {
    const pairs = [];
    for (let i = 0; i < 500; i++) {
      await seedFile(`f-${i}`);
      await seedTx(`t-${i}`);
      pairs.push({ fileId: `f-${i}`, transactionId: `t-${i}`, matchConfidence: 90 });
    }
    const outcomes = await connectFiles(db, ME, pairs, { origin: "auto" });
    expect(outcomes.filter((o: ConnectOutcome) => o.status === "connected")).toHaveLength(500);
    expect(await records()).toHaveLength(500);
    expect((await data("files", "f-499")).transactionIds).toEqual(["t-499"]);
    expect((await data("transactions", "t-0")).fileIds).toEqual(["f-0"]);
  }, 120_000);

  it("Partner matching connects a full run through it, refusing a deleted File", async () => {
    await db.collection("partners").doc("p-1").set({ userId: ME, name: "Hetzner" });
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const amount = -(1000 + i * 37);
      await seedFile(`pf-${i}`, { partnerId: "p-1", extractedAmount: Math.abs(amount), extractedDate: DAY, ...(i === 0 ? { deletedAt: DAY } : {}) });
      await seedTx(`pt-${i}`, { partnerId: "p-1", amount });
      ids.push(`pt-${i}`);
    }
    const result = await matchFilesForPartnerInternal(ME, "p-1", ids);
    expect(result.autoMatched).toBe(99);
    expect(await records("pf-0")).toHaveLength(0);
    expect(await isConnected("pf-42", "pt-42")).toBe(true);
  }, 120_000);
});

describe("deleting Transactions with their bank account or import", () => {
  async function seedAccount() {
    await db.collection("sources").doc("s-1").set({ userId: ME, name: "Giro" });
    await seedTx("t-1", { sourceId: "s-1", importJobId: "imp-1", fileIds: ["f-1"] });
    await seedTx("t-keep", { sourceId: "s-2", fileIds: ["f-2"] });
    await seedFile("f-1", { transactionIds: ["t-1"] });
    // Listed by the File alone, with no record behind it.
    await seedFile("f-2", { transactionIds: ["t-1", "t-keep"] });
    await db.collection("fileConnections").doc(connectionDocId("f-1", "t-1")).set({ userId: ME, fileId: "f-1", transactionId: "t-1" });
    await db.collection("fileConnections").doc(connectionDocId("f-2", "t-keep")).set({ userId: ME, fileId: "f-2", transactionId: "t-keep" });
  }

  async function expectNoFileListsAGoneTransaction() {
    expect((await db.collection("transactions").doc("t-1").get()).exists).toBe(false);
    expect((await data("files", "f-1")).transactionIds).toEqual([]);
    expect((await data("files", "f-2")).transactionIds).toEqual(["t-keep"]);
    expect((await records()).map((r) => r.id)).toEqual([connectionDocId("f-2", "t-keep")]);
  }

  it("deleteTransactionsBySource", async () => {
    await seedAccount();
    await call(deleteTransactionsBySourceCallable, { sourceId: "s-1" });
    await expectNoFileListsAGoneTransaction();
  });

  it("deleteSource", async () => {
    await seedAccount();
    await call(deleteSourceCallable, { sourceId: "s-1" });
    await expectNoFileListsAGoneTransaction();
  });

  it("deleteImportRecord, which used to empty the Files' whole lists", async () => {
    await seedAccount();
    await db.collection("imports").doc("imp-1").set({ userId: ME, sourceId: "s-1" });
    await call(deleteImportRecordCallable, { importId: "imp-1" });
    await expectNoFileListsAGoneTransaction();
  });
});

describe("deleting a File", () => {
  it("a connect that lands while the File is being detached is refused", async () => {
    await seedPair();
    await seedTx("t-2");
    await connect("manual");

    // Partner matching connects the File to another Transaction halfway
    // through the delete, after its records were read.
    const original = partnerProvenance.partnerRevertForRemovedConnection;
    let raced: ConnectOutcome | undefined;
    const spy = vi.spyOn(partnerProvenance, "partnerRevertForRemovedConnection").mockImplementation(async (...args) => {
      raced ??= await connect("auto", {}, { fileId: "f-1", transactionId: "t-2" });
      return original(...args);
    });
    try {
      await performDeleteFile(db, ME, "f-1", await data("files", "f-1"));
    } finally {
      spy.mockRestore();
    }

    expect(raced).toMatchObject({ status: "refused", reason: "deleted" });
    expect(await records("f-1")).toHaveLength(0);
    expect((await data("transactions", "t-2")).fileIds).toEqual([]);
    expect(await data("files", "f-1")).toMatchObject({ transactionIds: [], hadTransactionConnections: true });
    expect((await data("files", "f-1")).deletedAt).toBeTruthy();
  });

  it("stamps a File attached only by a record as having been attached", async () => {
    await seedPair();
    await seedTx("t-2", { fileIds: ["f-1"] });
    await db.collection("fileConnections").doc("legacy-unlisted").set({ userId: ME, fileId: "f-1", transactionId: "t-2", createdAt: DAY });
    const result = await performDeleteFile(db, ME, "f-1", await data("files", "f-1"));
    expect(result.detachedTransactions.map((t) => t.transactionId)).toEqual(["t-2"]);
    expect(await data("files", "f-1")).toMatchObject({ hadTransactionConnections: true });
  });
});

describe("the Copy swap", () => {
  it("moves the Copy's File Connection to the original under the pair's id", async () => {
    await seedFile("f-orig", { createdAt: DAY });
    await seedFile("f-copy", { transactionIds: ["t-1"] });
    await seedTx("t-1", { fileIds: ["f-copy"] });
    await db.collection("fileConnections").doc("legacy-copy").set({ userId: ME, fileId: "f-copy", transactionId: "t-1", connectionType: "manual" });
    await call(markFileAsCopyCallable, { fileId: "f-copy", originalFileId: "f-orig" });
    expect((await records()).map((r) => r.id)).toEqual([connectionDocId("f-orig", "t-1")]);
    expect(await isConnected("f-orig", "t-1")).toBe(true);
    expect((await data("files", "f-copy")).transactionIds).toEqual([]);
  });
});
