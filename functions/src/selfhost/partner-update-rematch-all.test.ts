/**
 * A Partner edit re-matches every affected File, not the first 200 (#329).
 *
 * The real trigger on the shim, with more Files than one page on each side of
 * both of its queries: Files auto-matched to the Partner, and unmatched Files
 * waiting for one. Before #329 each query stopped at 200 and said nothing, so
 * a user with a larger archive got a silent partial re-match.
 *
 * #306's guard is re-asserted at the same scale: a merge-caused write still
 * re-matches nothing, however many Files are waiting.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";

// REAL trigger module, unmodified:
import "../matching/onPartnerUpdate";
import { mergeUserPartnersInternal } from "../partners/mergeUserPartners";

const db = getFirestore();
const USER = "stefan-rematch-329";
const IBAN_A = "AT611904300234573201";
const IBAN_B = "DE89370400440532013000";

/** More than one 200-file page, and not a multiple of it. */
const PER_SIDE = 230;

function basePartner(name: string, overrides: Record<string, unknown> = {}) {
  return {
    userId: USER,
    name,
    aliases: [],
    ibans: [],
    isActive: true,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    ...overrides,
  };
}

function baseFile(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER,
    fileName: "rechnung.pdf",
    fileType: "application/pdf",
    extractionComplete: true,
    partnerMatchComplete: true,
    transactionIds: [],
    partnerId: null,
    extractedPartner: null,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    ...overrides,
  };
}

async function seedFiles(prefix: string, count: number, data: Record<string, unknown>) {
  for (let i = 0; i < count; i++) {
    const id = `${prefix}-${String(i).padStart(4, "0")}`;
    await db.collection("files").doc(id).set(baseFile(data));
  }
}

async function readFiles(prefix: string): Promise<Array<Record<string, unknown>>> {
  const snapshot = await db.collection("files").where("userId", "==", USER).get();
  return snapshot.docs.filter((doc) => doc.id.startsWith(`${prefix}-`)).map((doc) => doc.data()!);
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await __resetFirestoreShim();
  __resetTriggerShim();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
});

function logged(): string[] {
  return logSpy.mock.calls.map((call) => String(call[0]));
}

describe("selfhost hardening: a Partner edit re-matches every affected File (#329)", () => {
  it("considers every auto-matched and every unmatched File, past the first page", async () => {
    await db.collection("partners").doc("p-a").set(
      basePartner("Alpha Hosting GmbH", { ibans: [IBAN_A] }),
    );
    // Auto-matched on an IBAN the Partner is about to lose.
    await seedFiles("f-stale", PER_SIDE, {
      partnerId: "p-a",
      partnerType: "user",
      partnerMatchedBy: "auto",
      extractedIban: IBAN_A,
    });
    // Waiting for the IBAN the Partner is about to gain.
    await seedFiles("f-waiting", PER_SIDE, { extractedIban: IBAN_B });
    await drainTriggers();

    await db.collection("partners").doc("p-a").update({
      ibans: [IBAN_B],
      updatedAt: Timestamp.now(),
    });
    await drainTriggers();

    const stale = await readFiles("f-stale");
    expect(stale).toHaveLength(PER_SIDE);
    expect(stale.filter((f) => (f.partnerId ?? null) === null)).toHaveLength(PER_SIDE);

    const waiting = await readFiles("f-waiting");
    expect(waiting).toHaveLength(PER_SIDE);
    expect(waiting.filter((f) => f.partnerId === "p-a")).toHaveLength(PER_SIDE);
    expect(waiting.every((f) => f.partnerMatchedBy === "auto")).toBe(true);

    // The run says it covered everything, and how many.
    expect(logged()).toContainEqual(
      expect.stringContaining(`all ${PER_SIDE * 2} files considered (${PER_SIDE} auto-matched)`),
    );
  });

  it("re-matches every orphaned File after a soft-delete, past the first page", async () => {
    await db.collection("partners").doc("p-a").set(
      basePartner("Alpha Hosting GmbH", { ibans: [IBAN_A] }),
    );
    await db.collection("partners").doc("p-b").set(
      basePartner("Beta Services Ltd", { ibans: [IBAN_B] }),
    );
    await seedFiles("f-orphan", PER_SIDE, { extractedIban: IBAN_B });
    await drainTriggers();

    await db.collection("partners").doc("p-a").update({
      isActive: false,
      updatedAt: Timestamp.now(),
    });
    await drainTriggers();

    const orphans = await readFiles("f-orphan");
    expect(orphans.filter((f) => f.partnerId === "p-b")).toHaveLength(PER_SIDE);
    expect(logged()).toContainEqual(
      expect.stringContaining(`all ${PER_SIDE} orphaned files considered`),
    );
  });

  it("still re-matches nothing on a merge-caused write, however many Files wait (#306)", async () => {
    await db.collection("partners").doc("p-survivor").set(
      basePartner("Alpha Hosting GmbH", { ibans: [IBAN_A] }),
    );
    await db.collection("partners").doc("p-loser").set(
      basePartner("Alpha Hosting G.m.b.H.", { ibans: [IBAN_B] }),
    );
    await seedFiles("f-waiting", PER_SIDE, { extractedIban: IBAN_B });
    await drainTriggers();

    await mergeUserPartnersInternal(
      db as unknown as FirebaseFirestore.Firestore,
      USER,
      { survivorId: "p-survivor", loserIds: ["p-loser"] },
    );
    await drainTriggers();

    const survivor = (await db.collection("partners").doc("p-survivor").get()).data()!;
    expect(survivor.ibans).toEqual([IBAN_A, IBAN_B]);

    // Untouched down to the fields a re-match writes even when it changes nothing.
    const waiting = await readFiles("f-waiting");
    expect(waiting).toHaveLength(PER_SIDE);
    expect(waiting.every((f) => (f.partnerId ?? null) === null)).toBe(true);
    expect(waiting.every((f) => (f.partnerMatchedAt ?? null) === null)).toBe(true);
  });
});
