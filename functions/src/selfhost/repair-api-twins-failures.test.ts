/**
 * #685, the repair when a step goes wrong in a way its plan could not see:
 * the writer refuses a connect, the run dies between the connect and the
 * Unlink, or the User connects a File to the API twin mid-run. Each leaves
 * the pair in a state the next run finishes, never a File on neither row,
 * and the run goes on with the other pairs.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";

/** What the writer does wrong in the next run; reset before each test. */
const fault: { refuse?: string; unlinkThrows?: string; connectDuringUnlink?: { fileId: string; transactionId: string } } = {};

vi.mock("../fileConnections/writer", async (importOriginal) => {
  const real = await importOriginal<typeof import("../fileConnections/writer")>();
  return {
    ...real,
    connectFiles: async (...args: Parameters<typeof real.connectFiles>) => {
      const [, , pairs] = args;
      if (fault.refuse && pairs.some((p) => p.fileId === fault.refuse)) {
        return pairs.map((p) => ({
          fileId: p.fileId,
          transactionId: p.transactionId,
          status: "refused" as const,
          reason: "locked" as const,
          code: "failed-precondition" as const,
          message: "refused for the test",
        }));
      }
      return real.connectFiles(...args);
    },
    unlinkFile: async (...args: Parameters<typeof real.unlinkFile>) => {
      const [db, userId, request] = args;
      if (fault.unlinkThrows === request.fileId) throw new Error("the process died");
      const result = await real.unlinkFile(...args);
      if (fault.connectDuringUnlink) {
        const late = fault.connectDuringUnlink;
        fault.connectDuringUnlink = undefined;
        await real.connectFiles(db, userId, [late], { origin: "manual" });
      }
      return result;
    },
  };
});

// REAL application code, apart from the faults above:
import { repairApiTwins } from "../transactions/repairApiTwins";

const db = getFirestore();
const ME = "twins-fail-me";
const SRC = "src-giro";
const API = "api_1750000000001";
const CSV = "import_1755000000000_abc1234";
const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));
const JUNE = Timestamp.fromDate(new Date("2026-06-16T10:00:00Z"));

async function seedTx(id: string, importJobId: string, date: string, amount: number) {
  await db.collection("transactions").doc(id).set({
    userId: ME, sourceId: SRC, importJobId, date: day(date), amount, name: "CARD PAYMENT", fileIds: [], isComplete: false, createdAt: JUNE,
  });
}

async function seedFile(id: string) {
  await db.collection("files").doc(id).set({ userId: ME, fileName: `${id}.pdf`, fileType: "application/pdf", extractionComplete: true, transactionIds: [] });
}

beforeEach(async () => {
  await __resetFirestoreShim();
  __resetTriggerShim();
  delete fault.refuse;
  delete fault.unlinkThrows;
  delete fault.connectDuringUnlink;
  await db.collection("sources").doc(SRC).set({ userId: ME, name: "Giro" });
  await db.collection("imports").doc(CSV).set({ userId: ME, sourceId: SRC, status: "completed" });
  await seedTx("a-clean", API, "2026-03-02", -1999);
  await seedTx("c-clean", CSV, "2026-03-02", -1999);
  await seedTx("a-file", API, "2026-03-05", -4200);
  await seedTx("c-file", CSV, "2026-03-05", -4200);
  await seedFile("f-receipt");
  await seedFile("f-late");
  await db.collection("files").doc("f-receipt").update({ transactionIds: ["a-file"] });
  await db.collection("transactions").doc("a-file").update({ fileIds: ["f-receipt"], isComplete: true });
  await db.collection("fileConnections").doc("legacy-f-receipt").set({
    userId: ME, fileId: "f-receipt", transactionId: "a-file", connectionType: "api", matchConfidence: 0, createdAt: JUNE,
  });
});

async function run() {
  const dry = await repairApiTwins(db, { userId: ME, sourceId: SRC, apply: false });
  const report = await repairApiTwins(db, { userId: ME, sourceId: SRC, apply: true, reviewed: JSON.parse(JSON.stringify(dry.merges)) });
  await __whenShimIdle();
  return report;
}

async function tx(id: string) {
  const snap = await db.collection("transactions").doc(id).get();
  return snap.exists ? snap.data()! : null;
}

async function pairsOf(fileId: string) {
  const records = await db.collection("fileConnections").where("userId", "==", ME).where("fileId", "==", fileId).get();
  return {
    records: records.docs.map((d) => d.data().transactionId).sort(),
    listed: ((await db.collection("files").doc(fileId).get()).data()!.transactionIds as string[]).sort(),
  };
}

describe("the repair when a step fails", () => {
  it("reports a connect the writer refuses, leaves the File on the API twin and merges the other pairs", async () => {
    fault.refuse = "f-receipt";
    const report = await run();
    expect(report.failed).toEqual([
      { apiId: "a-file", csvId: "c-file", step: "connect f-receipt", message: "refused (locked): refused for the test" },
    ]);
    expect(await tx("a-file")).toMatchObject({ fileIds: ["f-receipt"] });
    expect(await tx("c-file")).toMatchObject({ fileIds: [] });
    expect(await pairsOf("f-receipt")).toEqual({ records: ["a-file"], listed: ["a-file"] });
    expect(await tx("a-clean")).toBeNull();
  });

  it("leaves a File on both twins when the run dies between connect and Unlink, and the next run finishes it", async () => {
    fault.unlinkThrows = "f-receipt";
    const first = await run();
    expect(first.failed).toEqual([{ apiId: "a-file", csvId: "c-file", step: "unlink f-receipt", message: "the process died" }]);
    expect(await pairsOf("f-receipt")).toEqual({ records: ["a-file", "c-file"], listed: ["a-file", "c-file"] });
    expect(await tx("a-file")).not.toBeNull();

    delete fault.unlinkThrows;
    const second = await run();
    expect(second.merges).toEqual([expect.objectContaining({ apiId: "a-file", moves: [], unlinkOnly: ["f-receipt"], done: true })]);
    expect(await tx("a-file")).toBeNull();
    expect(await pairsOf("f-receipt")).toEqual({ records: ["c-file"], listed: ["c-file"] });
  });

  it("keeps the API row, and the File, when a File is connected to it mid-run", async () => {
    fault.connectDuringUnlink = { fileId: "f-late", transactionId: "a-file" };
    const report = await run();
    expect(report.failed).toEqual([
      { apiId: "a-file", csvId: "c-file", step: "delete", message: "the API row holds a File again (f-late)" },
    ]);
    expect(await tx("a-file")).toMatchObject({ fileIds: ["f-late"] });
    expect(await pairsOf("f-late")).toEqual({ records: ["a-file"], listed: ["a-file"] });
    expect(await pairsOf("f-receipt")).toEqual({ records: ["c-file"], listed: ["c-file"] });
  });
});
