/**
 * A Cash Box (#787): a Bank Account kind (`cash`) with no bank behind it.
 * It takes a name and a currency, nothing a bank would print: no IBAN, no
 * card, no linked account, no broker. It still gets a Source Partner built
 * from its name, and it never carries a balance, because FiBuKI cannot know
 * what is in the box.
 *
 * Driven through the create and update callables and through handleTool
 * (MCP `create_source`), against the self-host database layer.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim, drainTriggers } from "./trigger-shim";

// REAL application code, unmodified:
import { createSourceCallable } from "../sources/createSource";
import { updateSourceCallable } from "../sources/updateSource";
import { bulkCreateTransactionsCallable } from "../imports/bulkCreateTransactions";
import { getAccountBalancesCallable } from "../sources/getAccountBalances";
import { handleTool } from "../tools/handlers";
import { TOOL_DEFINITIONS } from "../tools/definitions";

const db = getFirestore();
const USER = "stefan-test";
const AUTH = { uid: USER };

function createSource(data: Record<string, unknown>) {
  return createSourceCallable.run({ data: { data }, auth: AUTH } as never) as Promise<{ sourceId: string }>;
}

function updateSource(sourceId: string, data: Record<string, unknown>) {
  return updateSourceCallable.run({ data: { sourceId, data }, auth: AUTH } as never);
}

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
});

describe("Cash Box: created through the createSource callable", () => {
  it("stores a Cash Box with a name and a currency, a Source Partner from its name, and no balance", async () => {
    const { sourceId } = await createSource({ name: "Kassa", accountKind: "cash", currency: "EUR", type: "manual" });
    await drainTriggers();

    const source = (await db.collection("sources").doc(sourceId).get()).data()!;
    expect(source).toMatchObject({ name: "Kassa", accountKind: "cash", currency: "EUR", iban: null, userId: USER });
    expect(source.openingBalance ?? null).toBeNull();
    expect(source.latestBalance ?? null).toBeNull();

    expect(source.sourcePartnerId).toBeTruthy();
    const partner = (await db.collection("partners").doc(source.sourcePartnerId).get()).data()!;
    expect(partner).toMatchObject({ name: "Kassa", ibans: [], identitySourceField: `source:${sourceId}` });
  });

  it.each([
    ["an IBAN", { iban: "AT61 1904 3002 3457 3201" }],
    ["card digits", { cardLast4: "4242" }],
    ["a card brand", { cardBrand: "visa" }],
    ["a linked account", { linkedSourceId: "src-bank" }],
    ["a broker", { brokerName: "Flatex" }],
  ])("refuses %s on a Cash Box and stores nothing", async (_what, extra) => {
    await expect(
      createSource({ name: "Kassa", accountKind: "cash", currency: "EUR", type: "manual", ...extra })
    ).rejects.toMatchObject({ code: "invalid-argument" });
    expect((await db.collection("sources").get()).size).toBe(0);
  });

  it("refuses a kind that does not exist", async () => {
    await expect(
      createSource({ name: "Sparschwein", accountKind: "piggy_bank", currency: "EUR", type: "manual" })
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });
});

describe("Cash Box: created over MCP create_source", () => {
  it("advertises cash as a kind in the create_source schema", () => {
    const def = TOOL_DEFINITIONS.find((d) => d.name === "create_source")!;
    const kind = (def.inputSchema.properties as Record<string, { enum?: string[] }>).accountKind;
    expect(kind.enum).toContain("cash");
  });

  it("creates a Cash Box that list_sources and get_source report as cash", async () => {
    const { sourceId } = (await handleTool(USER, "create_source", { name: "Kassa", accountKind: "cash" })) as {
      sourceId: string;
    };
    await drainTriggers();

    expect(await handleTool(USER, "get_source", { sourceId })).toMatchObject({
      id: sourceId,
      accountKind: "cash",
      currency: "EUR",
      iban: null,
    });
    const listed = (await handleTool(USER, "list_sources", {})) as Array<{ id: string; accountKind: string }>;
    expect(listed.find((s) => s.id === sourceId)?.accountKind).toBe("cash");
  });

  it("refuses an IBAN on a Cash Box", async () => {
    await expect(
      handleTool(USER, "create_source", { name: "Kassa", accountKind: "cash", iban: "AT611904300234573201" })
    ).rejects.toThrow(/Cash Box/);
    expect((await db.collection("sources").get()).size).toBe(0);
  });
});

describe("Cash Box: edited through the updateSource callable", () => {
  it("refuses an IBAN or a balance on a Cash Box", async () => {
    const { sourceId } = await createSource({ name: "Kassa", accountKind: "cash", currency: "EUR", type: "manual" });

    await expect(updateSource(sourceId, { iban: "AT611904300234573201" })).rejects.toMatchObject({
      code: "invalid-argument",
    });
    await expect(updateSource(sourceId, { latestBalance: 5000 })).rejects.toMatchObject({ code: "invalid-argument" });
    await expect(updateSource(sourceId, { openingBalance: 5000 })).rejects.toMatchObject({ code: "invalid-argument" });

    const source = (await db.collection("sources").doc(sourceId).get()).data()!;
    expect(source.iban).toBeNull();
    expect(source.latestBalance ?? null).toBeNull();
  });

  it("renames a Cash Box and changes its currency", async () => {
    const { sourceId } = await createSource({ name: "Kassa", accountKind: "cash", currency: "EUR", type: "manual" });
    await updateSource(sourceId, { name: "Handkassa", currency: "CHF" });
    expect((await db.collection("sources").doc(sourceId).get()).data()).toMatchObject({
      name: "Handkassa",
      currency: "CHF",
      accountKind: "cash",
    });
  });

  it("turning a bank account into a Cash Box drops its IBAN, card, link and balance", async () => {
    const { sourceId } = await createSource({
      name: "Fake bank",
      accountKind: "bank_account",
      iban: "AT611904300234573201",
      currency: "EUR",
      type: "manual",
    });
    await db.collection("sources").doc(sourceId).update({ latestBalance: 1234, openingBalance: 100 });

    await updateSource(sourceId, { accountKind: "cash" });

    const source = (await db.collection("sources").doc(sourceId).get()).data()!;
    expect(source.accountKind).toBe("cash");
    expect(source.iban ?? null).toBeNull();
    expect(source.latestBalance ?? null).toBeNull();
    expect(source.openingBalance ?? null).toBeNull();
  });

  it("refuses a kind that does not exist", async () => {
    const { sourceId } = await createSource({ name: "Kassa", accountKind: "cash", currency: "EUR", type: "manual" });
    await expect(updateSource(sourceId, { accountKind: "checking" })).rejects.toMatchObject({
      code: "invalid-argument",
    });
  });
});

describe("Cash Box: a CSV import keeps no balance", () => {
  it("imports the rows into a Cash Box but ignores the CSV's balance", async () => {
    const { sourceId } = await createSource({ name: "Kassa", accountKind: "cash", currency: "EUR", type: "manual" });

    await bulkCreateTransactionsCallable.run({
      data: {
        sourceId,
        transactions: [
          {
            sourceId,
            date: "2026-07-05T22:00:00.000Z",
            amount: -450,
            currency: "EUR",
            name: "Parkschein",
            dedupeHash: "hash-1",
            importJobId: "job-1",
            csvRowIndex: 0,
            _original: { date: "06.07.2026", amount: "-4,50", rawRow: {} },
          },
        ],
        balanceInfo: {
          openingBalance: 10000,
          openingBalanceDate: "2026-07-01T00:00:00.000Z",
          latestBalance: 9550,
          latestBalanceDate: "2026-07-06T00:00:00.000Z",
        },
      },
      auth: AUTH,
    } as never);

    expect((await db.collection("transactions").where("sourceId", "==", sourceId).get()).size).toBe(1);
    const source = (await db.collection("sources").doc(sourceId).get()).data()!;
    expect(source.latestBalance ?? null).toBeNull();
    expect(source.openingBalance ?? null).toBeNull();
  });
});

describe("Cash Box: no balance in the account balances report", () => {
  it("lists the bank account's balance and leaves the Cash Box out", async () => {
    const bank = await createSource({ name: "Erste", accountKind: "bank_account", currency: "EUR", type: "manual" });
    const cash = await createSource({ name: "Kassa", accountKind: "cash", currency: "EUR", type: "manual" });
    for (const sourceId of [bank.sourceId, cash.sourceId]) {
      await db.collection("transactions").add({
        userId: USER,
        sourceId,
        amount: -450,
        name: "Parkschein",
        date: new Date("2026-07-06T00:00:00Z"),
      });
    }

    const { balances } = (await getAccountBalancesCallable.run({
      data: { date: "2026-12-31" },
      auth: AUTH,
    } as never)) as { balances: Array<{ sourceId: string; balanceAtDate: number }> };

    expect(balances.map((b) => b.sourceId)).toEqual([bank.sourceId]);
    expect(balances[0].balanceAtDate).toBe(-450);
  });
});
