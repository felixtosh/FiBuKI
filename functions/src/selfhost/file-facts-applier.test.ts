/**
 * The File facts module's applier on the self-host Firestore shim (#638): it
 * writes the update the module returns, runs each follow-up, and does nothing
 * on a refusal. Then the two Hand Correction doors through it: the same
 * correction produces the same File, and an agent corrects a Due Date
 * through the MCP tool.
 *
 *   npx vitest run --config vitest.selfhost.config.ts src/selfhost/file-facts-applier.test.ts --pool=forks --maxWorkers=1
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";

// REAL application code, unmodified:
import { applyFactChange } from "../fileFacts/applyFactChange";
import { updateFileExtractedFieldsCallable } from "../files/updateFileExtractedFields";
import { updateFileExtraction } from "../tools/handlers";
import { retryExtractionForFile, RetryExtractionError } from "../extraction/retryExtractionOps";
import { deriveDocumentationState } from "../documents/documentationState";
import { toDateSafe } from "../utils/toDateSafe";

const db = getFirestore();
const ME = "facts-me";
const OTHER = "facts-other";

const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));
const isoOf = (value: unknown) => toDateSafe(value)?.toISOString().slice(0, 10) ?? null;

async function seedFile(id: string, extra: Record<string, unknown> = {}) {
  await db.collection("files").doc(id).set({
    userId: ME,
    fileName: `${id}.pdf`,
    partnerId: "p1",
    extractionComplete: true,
    transactionMatchComplete: true,
    extractedAmount: 9999,
    extractedCurrency: "EUR",
    extractedDate: day("2026-01-05"),
    extractedPartner: "Acme",
    invoiceDirection: "incoming",
    transactionIds: [],
    transactionSuggestions: [],
    ...extra,
  });
}

const fileData = async (id: string) => (await db.collection("files").doc(id).get()).data()!;
const txData = async (id: string) => (await db.collection("transactions").doc(id).get()).data()!;

type Callable = { run: (req: unknown) => Promise<unknown> };
function callUi(data: unknown) {
  return (updateFileExtractedFieldsCallable as unknown as Callable).run({
    data,
    auth: { uid: ME, token: {} },
  }) as Promise<{ changed: string[]; correctedFields: string[] }>;
}

beforeEach(async () => {
  await __resetFirestoreShim();
  await db.collection("partners").doc("p1").set({ userId: ME, name: "Acme GmbH", aliases: [] });
  await db.collection("transactions").doc("t1").set({
    userId: ME,
    amount: -1000,
    currency: "EUR",
    date: day("2026-01-06"),
    name: "Acme GmbH 4711",
    partnerId: "p1",
    fileIds: [],
  });
});

describe("the applier", () => {
  it("writes the update and re-scores the suggestions, connecting nothing", async () => {
    await seedFile("f1");

    const result = await applyFactChange(db, {
      fileId: "f1",
      userId: ME,
      change: { origin: "mcp-correction", correction: { amount: 1000 } },
    });

    expect(result.refused).toBe(false);
    const file = await fileData("f1");
    expect(file.extractedAmount).toBe(1000);
    expect(Object.keys(file.extractionCorrectedFields)).toEqual(["amount"]);
    // The follow-up: the corrected amount now matches the bank line.
    expect((file.transactionSuggestions as Array<{ transactionId: string }>).map((s) => s.transactionId))
      .toContain("t1");
    // Suggestions only.
    expect(file.transactionIds).toEqual([]);
    expect((await txData("t1")).fileIds).toEqual([]);
    const connections = await db.collection("fileConnections").where("userId", "==", ME).get();
    expect(connections.size).toBe(0);
  });

  it("leaves the suggestions of a File with a manual File Connection, the one re-scorer's rule", async () => {
    await seedFile("f1", { transactionSuggestions: [{ transactionId: "t-kept", confidence: 50 }] });
    await db.collection("fileConnections").doc("fc-manual").set({
      userId: ME,
      fileId: "f1",
      transactionId: "t-other",
      connectionType: "manual",
    });

    await applyFactChange(db, {
      fileId: "f1",
      userId: ME,
      change: { origin: "mcp-correction", correction: { amount: 1000 } },
    });

    const file = await fileData("f1");
    expect(file.extractedAmount).toBe(1000);
    expect((file.transactionSuggestions as Array<{ transactionId: string }>).map((s) => s.transactionId))
      .toEqual(["t-kept"]);
  });

  it("syncs the Documentation State of a connected Transaction when the Document Type moved", async () => {
    // A stored classification no current rule produces, so any correction moves it.
    await db.collection("transactions").doc("t1").update({
      fileIds: ["f1"],
      documentationState: "stale",
    });
    await seedFile("f1", { transactionIds: ["t1"], documentType: "stale" });

    await applyFactChange(db, {
      fileId: "f1",
      userId: ME,
      change: { origin: "mcp-correction", correction: { vatPercent: 20 } },
    });

    const file = await fileData("f1");
    expect(file.documentType).not.toBe("stale");
    expect((await txData("t1")).documentationState).toBe(
      deriveDocumentationState({ fileTypes: [file.documentType], hasNoReceiptCategory: false })
    );
  });

  it("does nothing on a refusal", async () => {
    await seedFile("f1", { updatedAt: day("2026-01-01") });
    const before = await fileData("f1");

    const result = await applyFactChange(db, {
      fileId: "f1",
      userId: ME,
      change: { origin: "mcp-correction", correction: { amount: 1000, vatPercent: 120 } },
    });

    expect(result).toMatchObject({ refused: true, code: "INVALID" });
    expect(await fileData("f1")).toEqual(before);
  });

  it("answers someone else's File like a missing one, and writes nothing", async () => {
    await seedFile("f1", { userId: OTHER });
    const before = await fileData("f1");

    const result = await applyFactChange(db, {
      fileId: "f1",
      userId: ME,
      change: { origin: "mcp-correction", correction: { amount: 1000 } },
    });

    expect(result).toMatchObject({ refused: true, code: "NOT_FOUND" });
    expect(await fileData("f1")).toEqual(before);
  });
});

describe("the two Hand Correction doors", () => {
  /** The facts a File carries, without the instants that only say when. */
  async function facts(id: string) {
    const file = await fileData(id);
    const {
      fileName: _name,
      updatedAt: _updated,
      transactionMatchedAt: _matched,
      extractionCorrectedAt: _at,
      // Names the door it came in by, so it is the one field that differs.
      lastFactChange: _door,
      // So does the log line (#752): the panel is the User, the MCP tool is AI.
      automationHistory: _log,
      extractionCorrectedFields,
      ...rest
    } = file;
    return { ...rest, recorded: Object.keys(extractionCorrectedFields ?? {}).sort() };
  }

  it("produce the same File for the same correction", async () => {
    const seed = {
      extractedAdditionalFields: [{ key: "dueDate", label: "Fällig am", value: "2026-01-20" }],
      extractedDueDate: day("2026-01-20"),
    };
    await seedFile("f-ui", seed);
    await seedFile("f-mcp", seed);

    await callUi({
      fileId: "f-ui",
      correction: { amount: 1000, date: "2026-01-06" },
      details: {
        partner: "Acme GmbH",
        additionalFields: [{ key: "dueDate", label: "Fällig am", value: "2026-01-31" }],
      },
    });
    await updateFileExtraction(ME, {
      fileId: "f-mcp",
      amount: 1000,
      date: "2026-01-06",
      partner: "Acme GmbH",
      additionalFields: [{ key: "dueDate", label: "Fällig am", value: "2026-01-31" }],
    });

    const ui = await facts("f-ui");
    expect(await facts("f-mcp")).toEqual(ui);
    expect(ui.recorded).toEqual(["amount", "date", "dueDate"]);
    expect(isoOf(ui.extractedDueDate)).toBe("2026-01-31");
  });

  it("let an agent correct a Due Date through the MCP tool, which a later re-extraction respects", async () => {
    await seedFile("f1", {
      extractedAdditionalFields: [
        { key: "invoiceNumber", label: "Rechnungsnummer", value: "R-1" },
        { key: "dueDate", label: "Fällig am", value: "2026-01-20" },
      ],
      extractedDueDate: day("2026-01-20"),
    });

    const reply = await updateFileExtraction(ME, {
      fileId: "f1",
      additionalFields: [
        { key: "invoiceNumber", label: "Rechnungsnummer", value: "R-1" },
        { key: "dueDate", label: "Fällig am", value: "2026-02-15" },
      ],
    });

    expect(reply.changed).toEqual(["dueDate"]);
    expect(reply.file.extractedDueDate).toBe("2026-02-15");
    const file = await fileData("f1");
    expect(isoOf(file.extractedDueDate)).toBe("2026-02-15");
    expect(file.extractedAdditionalFields).toHaveLength(2);

    await expect(
      retryExtractionForFile(db, { fileId: "f1", userId: ME, force: true })
    ).rejects.toThrow(RetryExtractionError);
    expect(isoOf((await fileData("f1")).extractedDueDate)).toBe("2026-02-15");
  });
});
