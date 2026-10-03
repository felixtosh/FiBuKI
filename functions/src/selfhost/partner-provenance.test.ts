/**
 * A Partner the payee rule filled from a File goes when the File does (#584).
 *
 * The payee rule (ADR-0011) fills an empty Transaction Partner when every
 * connected File names the same one. Removing a File Connection, by any path,
 * derives that Partner again from the Files that remain, unless someone
 * changed or confirmed it since. These cases drive the real callables,
 * triggers and tool handlers against the self-host database and read only the
 * stored Partner fields and activity.
 */
process.env.FIBUKI_STORAGE = "memory";
import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";
import { connectFileToTransactionCallable } from "../files/connectFileToTransaction";
import { disconnectFileFromTransactionCallable } from "../files/disconnectFileFromTransaction";
import { performDeleteFile } from "../files/deleteFile";
import { markFileAsCopy } from "../files/copyOps";
import { runTransactionMatching } from "../matching/matchFileTransactions";
import "../matching/matchFilePartner";
import {
  connectFileToTransaction as connectTool,
  disconnectFileFromTransaction as disconnectTool,
} from "../tools/handlers";
import { mergeUserPartnersInternal } from "../partners/mergeUserPartners";
import { buildPartnerRematchReport } from "../matching/partnerRematchReport";
import { rematchAssignedPartners } from "../matching/rematchAssignedPartners";

const db = getFirestore();
/** The shim as the operations type their Firestore argument. */
const adminDb = db as unknown as FirebaseFirestore.Firestore;
const ME = "prov-me";
const OTHER = "prov-other";
const IBAN_BANK = "AT61 1904 3002 3457 3201";
const IBAN_HETZNER = "DE89 3704 0044 0532 0130 00";
const DAY = Timestamp.fromDate(new Date("2026-07-01T00:00:00Z"));

type Callable = { run: (req: unknown) => Promise<unknown> };
function call<T>(fn: unknown, data: unknown, uid = ME): Promise<T> {
  return (fn as Callable).run({ data, auth: { uid, token: {} } }) as Promise<T>;
}

const connect = (fileId: string, transactionId: string, extra: Record<string, unknown> = {}) =>
  call(connectFileToTransactionCallable, { fileId, transactionId, ...extra });
const disconnect = (fileId: string, transactionId: string, rejectFile = false) =>
  call(disconnectFileFromTransactionCallable, { fileId, transactionId, rejectFile });

async function tx(id: string) {
  return (await db.collection("transactions").doc(id).get()).data()!;
}
async function file(id: string) {
  return (await db.collection("files").doc(id).get()).data()!;
}

function partner(id: string, name: string, extra: Record<string, unknown> = {}) {
  return db.collection("partners").doc(id).set({
    userId: ME,
    name,
    aliases: [],
    ibans: [],
    isActive: true,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    ...extra,
  });
}

function transaction(id: string, extra: Record<string, unknown> = {}) {
  return db.collection("transactions").doc(id).set({
    userId: ME,
    sourceId: "src",
    date: DAY,
    amount: -49.9,
    currency: "EUR",
    name: "OEGK BEITRAG 07/2026",
    partner: "Oesterreichische Gesundheitskasse",
    partnerIban: "AT02 2011 1000 0000 0000",
    reference: "Beitrag Juli",
    fileIds: [],
    isComplete: false,
    partnerId: null,
    partnerType: null,
    partnerMatchedBy: null,
    partnerMatchConfidence: null,
    partnerSuggestions: [],
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    ...extra,
  });
}

function invoiceFile(id: string, extra: Record<string, unknown> = {}) {
  return db.collection("files").doc(id).set({
    userId: ME,
    fileName: `${id}.pdf`,
    fileType: "application/pdf",
    storagePath: `files/${ME}/${id}.pdf`,
    extractionComplete: true,
    partnerMatchComplete: true,
    transactionMatchComplete: true,
    transactionIds: [],
    partnerId: null,
    partnerType: null,
    partnerMatchedBy: null,
    partnerMatchConfidence: null,
    uploadedAt: Timestamp.now(),
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    ...extra,
  });
}

const magentaFile = (id = "f-magenta", extra: Record<string, unknown> = {}) =>
  invoiceFile(id, {
    partnerId: "p-magenta",
    partnerType: "user",
    partnerMatchedBy: "auto",
    partnerMatchConfidence: 95,
    ...extra,
  });

function activityTypes(data: FirebaseFirestore.DocumentData, fileId: string): string[] {
  return ((data.automationHistory || []) as Array<{ type: string; fileId?: string }>)
    .filter((e) => e.fileId === fileId)
    .map((e) => e.type);
}

beforeEach(async () => {
  await __resetFirestoreShim();
  __resetTriggerShim();
  await db.collection("subscriptions").doc(ME).set({ userId: ME, automationMode: "passive", planId: "free" });
  await partner("p-bank", "Sparkasse Oberoesterreich", { ibans: [IBAN_BANK] });
  await partner("p-magenta", "Magenta Telekom");
  await partner("p-other", "Google Cloud EMEA");
  await db.collection("partners").doc("p-foreign").set({
    userId: OTHER,
    name: "Someone Else GmbH",
    isActive: true,
  });
  await transaction("t-plain");
  await transaction("t-loan", {
    name: "SPARKASSE KREDITRATE",
    partner: "Sparkasse Oberoesterreich",
    partnerIban: IBAN_BANK,
    reference: "Kredit 123",
  });
  await magentaFile();
});

describe("disconnecting the File that supplied the Partner", () => {
  it("leaves the Transaction without a Partner when its bank data matches none", async () => {
    await connect("f-magenta", "t-plain");
    expect((await tx("t-plain")).partnerId).toBe("p-magenta");
    expect((await tx("t-plain")).partnerFromFiles).toEqual({ partnerId: "p-magenta", matchedBy: "auto" });

    await disconnect("f-magenta", "t-plain");

    const after = await tx("t-plain");
    expect(after.partnerId).toBeNull();
    expect(after.partnerMatchedBy).toBeNull();
    expect(after.partnerFromFiles).toBeNull();
    expect(activityTypes(after, "f-magenta")).toEqual(["file_connected", "file_disconnected", "partner_removed"]);
  });

  it("matches the Transaction again from its bank data", async () => {
    await connect("f-magenta", "t-loan");
    expect((await tx("t-loan")).partnerId).toBe("p-magenta");

    await disconnect("f-magenta", "t-loan");

    const after = await tx("t-loan");
    expect(after.partnerId).toBe("p-bank");
    expect(after.partnerMatchedBy).toBe("auto");
  });

  it("reverts on a Rejection too, and records no manual removal", async () => {
    await connect("f-magenta", "t-plain");
    await disconnect("f-magenta", "t-plain", true);

    const after = await tx("t-plain");
    expect(after.partnerId).toBeNull();
    expect(after.rejectedFileIds).toContain("f-magenta");
    const magenta = (await db.collection("partners").doc("p-magenta").get()).data()!;
    expect(magenta.manualRemovals ?? []).toEqual([]);
  });

  it("keeps the Partner while the Files that remain still name it", async () => {
    await magentaFile("f-magenta-2");
    await connect("f-magenta", "t-plain");
    await connect("f-magenta-2", "t-plain");

    await disconnect("f-magenta", "t-plain");
    expect((await tx("t-plain")).partnerId).toBe("p-magenta");

    await disconnect("f-magenta-2", "t-plain");
    expect((await tx("t-plain")).partnerId).toBeNull();
  });

  it("takes the Partner the remaining Files agree on", async () => {
    await invoiceFile("f-gcloud", {
      partnerId: "p-other",
      partnerType: "user",
      partnerMatchedBy: "auto",
      partnerMatchConfidence: 90,
    });
    await connect("f-magenta", "t-plain");
    await connect("f-gcloud", "t-plain");
    // A set Partner is never changed by a File (ADR-0011).
    expect((await tx("t-plain")).partnerId).toBe("p-magenta");

    await disconnect("f-magenta", "t-plain");

    const after = await tx("t-plain");
    expect(after.partnerId).toBe("p-other");
    expect(after.partnerFromFiles).toEqual({ partnerId: "p-other", matchedBy: "auto" });
  });

  it("leaves a Partner the Transaction had before the connect alone", async () => {
    await db.collection("transactions").doc("t-plain").update({
      partnerId: "p-other",
      partnerType: "user",
      partnerMatchedBy: "suggestion",
      partnerMatchConfidence: 80,
    });
    await connect("f-magenta", "t-plain");
    await disconnect("f-magenta", "t-plain");

    const after = await tx("t-plain");
    expect(after.partnerId).toBe("p-other");
    expect(after.partnerMatchedBy).toBe("suggestion");
  });
});

describe("a Partner changed or confirmed after the connect", () => {
  it("survives when set by hand", async () => {
    await connect("f-magenta", "t-plain");
    await db.collection("transactions").doc("t-plain").update({
      partnerId: "p-other",
      partnerMatchedBy: "manual",
      partnerMatchConfidence: 100,
    });
    await disconnect("f-magenta", "t-plain");

    const after = await tx("t-plain");
    expect(after.partnerId).toBe("p-other");
    expect(after.partnerMatchedBy).toBe("manual");
  });

  it("survives when the same Partner is confirmed by hand", async () => {
    await connect("f-magenta", "t-plain");
    await db.collection("transactions").doc("t-plain").update({ partnerMatchedBy: "manual" });
    await disconnect("f-magenta", "t-plain");

    expect((await tx("t-plain")).partnerId).toBe("p-magenta");
  });

  it("survives when a writer that knows nothing of the record writes another Partner", async () => {
    await connect("f-magenta", "t-plain");
    await db.collection("transactions").doc("t-plain").update({
      partnerId: "p-other",
      partnerMatchedBy: "auto",
    });
    await disconnect("f-magenta", "t-plain");

    expect((await tx("t-plain")).partnerId).toBe("p-other");
  });

  it("a later change of the File's Partner leaves the fill, which still goes with the File", async () => {
    await connect("f-magenta", "t-plain");
    await db.collection("files").doc("f-magenta").update({
      partnerId: "p-bank",
      partnerMatchedBy: "auto",
      partnerMatchConfidence: 92,
    });
    await drainTriggers();
    expect((await tx("t-plain")).partnerId).toBe("p-magenta");

    await disconnect("f-magenta", "t-plain");

    expect((await tx("t-plain")).partnerId).toBeNull();
  });
});

describe("every path that removes a File Connection", () => {
  it("the MCP connect and disconnect tools", async () => {
    await connectTool(ME, { fileId: "f-magenta", transactionId: "t-plain" });
    expect((await tx("t-plain")).partnerFromFiles).toEqual({ partnerId: "p-magenta", matchedBy: "auto" });

    await disconnectTool(ME, { fileId: "f-magenta", transactionId: "t-plain" });

    expect((await tx("t-plain")).partnerId).toBeNull();
  });

  it("deleting the File", async () => {
    await connect("f-magenta", "t-loan");
    await performDeleteFile(adminDb, ME, "f-magenta", await file("f-magenta"));

    expect((await tx("t-loan")).partnerId).toBe("p-bank");
  });

  it("marking the File as a Copy hands the Transaction to the original's Partner", async () => {
    await invoiceFile("f-original", {
      partnerId: "p-other",
      partnerType: "user",
      partnerMatchedBy: "auto",
      partnerMatchConfidence: 90,
    });
    await connect("f-magenta", "t-plain");
    await markFileAsCopy(adminDb, ME, { fileId: "f-magenta", originalFileId: "f-original" });

    const after = await tx("t-plain");
    expect(after.fileIds).toEqual(["f-original"]);
    expect(after.partnerId).toBe("p-other");
    expect(after.partnerFromFiles).toEqual({ partnerId: "p-other", matchedBy: "auto" });
  });

  it("connecting the File elsewhere with auto reassignment", async () => {
    await connect("f-magenta", "t-plain", { connectionType: "auto_matched" });
    await connect("f-magenta", "t-loan", { connectionType: "auto_matched", allowAutoReassign: true });

    const left = await tx("t-plain");
    expect(left.fileIds).toEqual([]);
    expect(left.partnerId).toBeNull();
    const target = await tx("t-loan");
    expect(target.partnerId).toBe("p-magenta");
    expect(target.partnerFromFiles).toEqual({ partnerId: "p-magenta", matchedBy: "auto" });
  });

  it("the automatic match on upload records its fill", async () => {
    await db.collection("subscriptions").doc(ME).update({ automationMode: "active" });
    await partner("p-hetzner", "Hetzner Online GmbH", { aliases: ["Hetzner"], ibans: [IBAN_HETZNER] });
    await transaction("t-hetzner", {
      amount: -119,
      name: "Hetzner Online GmbH",
      partner: "Hetzner Online GmbH",
      partnerIban: IBAN_HETZNER,
      reference: "Invoice R0011223344",
    });
    await invoiceFile("f-hetzner", {
      transactionMatchComplete: false,
      partnerId: "p-hetzner",
      partnerType: "user",
      partnerMatchedBy: "auto",
      partnerMatchConfidence: 98,
      extractedPartner: "Hetzner Online GmbH",
      extractedIban: IBAN_HETZNER,
      extractedAmount: 119,
      extractedCurrency: "EUR",
      extractedDate: DAY,
      extractedText: "Hetzner Online GmbH Rechnung R0011223344 119,00 EUR",
    });

    await runTransactionMatching("f-hetzner", await file("f-hetzner"));

    const connected = await tx("t-hetzner");
    expect(connected.fileIds).toEqual(["f-hetzner"]);
    expect(connected.partnerFromFiles).toEqual({ partnerId: "p-hetzner", matchedBy: "auto" });

    await disconnect("f-hetzner", "t-hetzner");

    const after = await tx("t-hetzner");
    expect(activityTypes(after, "f-hetzner")).toContain("partner_removed");
    // Matched again from its own bank data, which names the same business.
    expect(after.partnerId).toBe("p-hetzner");
    expect(after.partnerFromFiles ?? null).toBeNull();
  });
});

describe("a Partner merge", () => {
  it("keeps the revert working when the supplied Partner is merged away", async () => {
    await connect("f-magenta", "t-plain");
    await mergeUserPartnersInternal(adminDb, ME, { survivorId: "p-other", loserIds: ["p-magenta"] });
    const merged = await tx("t-plain");
    expect(merged.partnerId).toBe("p-other");
    expect(merged.partnerFromFiles).toMatchObject({ partnerId: "p-other" });

    await disconnect("f-magenta", "t-plain");
    expect((await tx("t-plain")).partnerId).toBeNull();
  });
});

describe("connecting a File whose Partner is a global preset", () => {
  it("writes the user's own copy of it", async () => {
    await db.collection("globalPartners").doc("g-a1").set({
      name: "A1 Telekom Austria AG",
      aliases: ["A1"],
      ibans: [],
      isActive: true,
    });
    await invoiceFile("f-a1", { partnerId: "g-a1", partnerType: "global", partnerMatchedBy: "auto" });
    await connect("f-a1", "t-plain");

    const after = await tx("t-plain");
    expect(after.partnerType).toBe("user");
    expect(after.partnerId).not.toBe("g-a1");
    const local = (await db.collection("partners").doc(after.partnerId as string).get()).data()!;
    expect(local.userId).toBe(ME);
    expect(local.globalPartnerId).toBe("g-a1");
  });
});

describe("finding stale Partners", () => {
  beforeEach(async () => {
    // The live shape: an automatic Partner, no File, bank text that never
    // names it. Next to it a correct one: a connected File carries it.
    await db.collection("transactions").doc("t-plain").update({
      partnerId: "p-magenta",
      partnerType: "user",
      partnerMatchedBy: "auto",
      partnerMatchConfidence: 95,
    });
    await transaction("t-backed", {
      name: "LASTSCHRIFT 0815 4711",
      partner: null,
      partnerIban: null,
      partnerId: "p-magenta",
      partnerType: "user",
      partnerMatchedBy: "auto",
      partnerMatchConfidence: 95,
      fileIds: ["f-magenta"],
    });
    await db.collection("files").doc("f-magenta").update({ transactionIds: ["t-backed"] });
  });

  it("the report flags the stale Partner and leaves the File-backed one out", async () => {
    const report = await buildPartnerRematchReport(ME, {});
    const flagged = report.rows.map((r) => r.transactionId);

    expect(flagged).toContain("t-plain");
    expect(flagged).not.toContain("t-backed");
    expect(report.fileBacked).toBe(1);
  });

  it("the re-match clears the stale Partner and never touches the File-backed one", async () => {
    await rematchAssignedPartners(ME, { dryRun: false, clearUnconfirmed: true });

    expect((await tx("t-plain")).partnerId).toBeNull();
    const backed = await tx("t-backed");
    expect(backed.partnerId).toBe("p-magenta");
    expect(backed.partnerMatchedBy).toBe("auto");
  });
});
