/**
 * The payee rule (#550, ADR-0011): a Transaction's Partner is the business
 * the money went to; a File's Partner is the supplier. Connecting a File
 * never overwrites the Transaction's Partner and never gives the File the
 * Transaction's. An empty one is filled only when every File names the same
 * Partner.
 *
 * Every case runs through each writer that used to sync "the File wins", so
 * the result cannot depend on which of them ran last.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";

// REAL application code, unmodified:
import { handleTool } from "../tools/handlers";
import { connectFileToTransactionCallable } from "../files/connectFileToTransaction";
import { matchFilePartner } from "../matching/matchFilePartner";

const db = getFirestore();
const USER = "stefan-test";

interface Scenario {
  /** The Transaction before the File arrives. */
  tx: { partnerId?: string; partnerMatchedBy?: string };
  /** Files already on the Transaction, by their Partner. */
  others?: Array<string | null>;
  /** The arriving File's Partner. */
  filePartnerId: string;
}

type Writer = (s: Scenario) => Promise<void>;

async function seedTransaction(s: Scenario, extraFileIds: string[] = []) {
  const otherIds = (s.others ?? []).map((_, i) => `f-other-${i}`);
  for (const [i, partnerId] of (s.others ?? []).entries()) {
    await db.collection("files").doc(otherIds[i]).set({
      userId: USER,
      fileName: `other-${i}.pdf`,
      partnerId,
      partnerType: partnerId ? "user" : null,
      transactionIds: ["t-1"],
      extractionComplete: true,
    });
  }
  await db.collection("transactions").doc("t-1").set({
    userId: USER,
    amount: -2020,
    name: "AMAZON MARKETPLACE",
    ...s.tx,
    fileIds: [...otherIds, ...extraFileIds],
  });
}

async function seedFile(partnerId: string | null, transactionIds: string[] = []) {
  await db.collection("files").doc("f-new").set({
    userId: USER,
    fileName: "new.pdf",
    partnerId,
    partnerType: partnerId ? "user" : null,
    partnerMatchConfidence: partnerId ? 92 : null,
    partnerMatchedBy: partnerId ? "auto" : null,
    partnerMatchComplete: true,
    extractionComplete: true,
    transactionIds,
  });
}

const connectByTool = () => handleTool(USER, "connect_file_to_transaction", { fileId: "f-new", transactionId: "t-1" });
const connectByCallable = () =>
  connectFileToTransactionCallable.run({
    data: { fileId: "f-new", transactionId: "t-1" },
    auth: { uid: USER, token: {} },
  } as never);

const viaConnectTool: Writer = async (s) => {
  await seedTransaction(s);
  await seedFile(s.filePartnerId);
  await connectByTool();
};

const viaConnectCallable: Writer = async (s) => {
  await seedTransaction(s);
  await seedFile(s.filePartnerId);
  await connectByCallable();
};

/** The File is already on the Transaction; Partner matching then assigns its Partner. */
const viaFilePartnerMatch: Writer = async (s) => {
  await seedTransaction(s, ["f-new"]);
  await seedFile(null, ["t-1"]);
  await db.collection("fileConnections").doc("c-new").set({ userId: USER, fileId: "f-new", transactionId: "t-1" });
  const before = (await db.collection("files").doc("f-new").get()).data()!;
  const after = { ...before, partnerId: s.filePartnerId, partnerType: "user", partnerMatchedBy: "auto" };
  await db.collection("files").doc("f-new").update(after);
  await (matchFilePartner as unknown as (e: unknown) => Promise<void>)({
    data: { before: { data: () => before }, after: { data: () => after } },
    params: { fileId: "f-new" },
  });
};

const WRITERS: Array<[string, Writer]> = [
  ["connect_file_to_transaction", viaConnectTool],
  ["the connect callable", viaConnectCallable],
  ["the File Partner match", viaFilePartnerMatch],
];

async function tx() {
  return (await db.collection("transactions").doc("t-1").get()).data()!;
}

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
});

describe.each(WRITERS)("the payee rule through %s", (_name, write) => {
  it("keeps a set Transaction Partner when the File names another", async () => {
    await write({ tx: { partnerId: "p-amazon", partnerMatchedBy: "auto" }, filePartnerId: "p-seller-pl" });
    expect(await tx()).toMatchObject({ partnerId: "p-amazon", partnerMatchedBy: "auto" });
    expect((await tx()).bankPartnerId).toBeUndefined();
  });

  it("keeps a Transaction Partner set by hand", async () => {
    await write({ tx: { partnerId: "p-uber", partnerMatchedBy: "manual" }, filePartnerId: "p-taxi-operator" });
    expect(await tx()).toMatchObject({ partnerId: "p-uber", partnerMatchedBy: "manual" });
  });

  it("fills an empty Transaction Partner when every File names the same one", async () => {
    await write({ tx: {}, others: ["p-hetzner"], filePartnerId: "p-hetzner" });
    expect(await tx()).toMatchObject({ partnerId: "p-hetzner", partnerMatchedBy: "auto", partnerType: "user" });
  });

  it("fills an empty Transaction Partner from its only File", async () => {
    await write({ tx: {}, filePartnerId: "p-hetzner" });
    expect((await tx()).partnerId).toBe("p-hetzner");
  });

  it("leaves an empty Transaction Partner empty when the Files name different ones", async () => {
    await write({ tx: {}, others: ["p-seller-pl"], filePartnerId: "p-seller-hk" });
    expect((await tx()).partnerId ?? null).toBeNull();
  });

  it("leaves it empty while another File has no Partner yet", async () => {
    await write({ tx: {}, others: [null], filePartnerId: "p-seller-hk" });
    expect((await tx()).partnerId ?? null).toBeNull();
  });
});

describe("a File without a Partner", () => {
  it.each([
    ["connect_file_to_transaction", connectByTool],
    ["the connect callable", connectByCallable],
  ] as Array<[string, () => Promise<unknown>]>)("is not given the Transaction's Partner through %s", async (_name, connect) => {
    await seedTransaction({ tx: { partnerId: "p-uber", partnerMatchedBy: "auto" }, filePartnerId: "" });
    await seedFile(null);
    await connect();
    expect((await db.collection("files").doc("f-new").get()).data()!.partnerId).toBeNull();
    expect((await tx()).partnerId).toBe("p-uber");
  });
});
