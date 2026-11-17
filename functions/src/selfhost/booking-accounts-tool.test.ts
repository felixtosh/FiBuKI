/**
 * #785: a File's or Transaction's Booking Accounts, set over the tool surface.
 *
 * An import from another bookkeeping tool (SevDesk) copies the accounts it
 * booked each receipt to. The list lives beside the Extraction: setting it is
 * not a Hand Correction, and a re-extraction leaves it alone.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";

// REAL application code, unmodified:
import { handleTool } from "../tools/handlers";

const db = getFirestore();
const USER = "booking-user";

const OFFICE = {
  accountNumber: "7600",
  accountName: "Büromaterial",
  skr03: "4930",
  skr04: "6815",
  isAsset: false,
  isGwg: false,
  vatPercent: 20,
  amount: 12000,
  origin: "sevdesk",
  externalId: "acc-office",
};

async function seedFile(id: string, extra: Record<string, unknown> = {}) {
  await db.collection("files").doc(id).set({
    userId: USER,
    fileName: `${id}.pdf`,
    extractedAmount: 12000,
    extractionComplete: true,
    ...extra,
  });
}

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
});

describe("set_booking_accounts on a File", () => {
  it("stores the list and get_file returns it", async () => {
    await seedFile("f-1");

    await handleTool(USER, "set_booking_accounts", { fileId: "f-1", bookingAccounts: [OFFICE] });

    const file = (await handleTool(USER, "get_file", { fileId: "f-1" })) as Record<string, unknown>;
    expect(file.bookingAccounts).toEqual([OFFICE]);
  });

  it("list_files returns it on the row", async () => {
    await seedFile("f-1");
    await seedFile("f-2");

    await handleTool(USER, "set_booking_accounts", { fileId: "f-1", bookingAccounts: [OFFICE] });

    const { files } = (await handleTool(USER, "list_files", {})) as { files: Array<Record<string, unknown>> };
    const byId = Object.fromEntries(files.map((f) => [f.id, f]));
    expect(byId["f-1"].bookingAccounts).toEqual([OFFICE]);
    expect(byId["f-2"].bookingAccounts).toBeUndefined();
  });
});

describe("set_booking_accounts replaces the list and logs each change", () => {
  const history = async (fileId: string) =>
    (((await handleTool(USER, "get_file", { fileId })) as Record<string, unknown>).automationHistory ?? []) as Array<
      Record<string, unknown>
    >;

  it("replaces the stored list wholesale and clears it with []", async () => {
    await seedFile("f-1");
    const asset = { ...OFFICE, accountNumber: "0620", accountName: "Büromaschinen", isAsset: true, amount: 8000 };
    const gwg = { ...OFFICE, accountNumber: "0680", accountName: "GWG", isGwg: true, amount: 4000 };

    await handleTool(USER, "set_booking_accounts", { fileId: "f-1", bookingAccounts: [OFFICE] });
    await handleTool(USER, "set_booking_accounts", { fileId: "f-1", bookingAccounts: [asset, gwg] });
    expect(((await handleTool(USER, "get_file", { fileId: "f-1" })) as Record<string, unknown>).bookingAccounts).toEqual([
      asset,
      gwg,
    ]);

    await handleTool(USER, "set_booking_accounts", { fileId: "f-1", bookingAccounts: [] });
    expect(((await handleTool(USER, "get_file", { fileId: "f-1" })) as Record<string, unknown>).bookingAccounts).toEqual([]);
  });

  it("writes one AI activity entry per change and none for a re-run", async () => {
    await seedFile("f-1");

    await handleTool(USER, "set_booking_accounts", { fileId: "f-1", bookingAccounts: [OFFICE] });
    const again = await handleTool(USER, "set_booking_accounts", { fileId: "f-1", bookingAccounts: [OFFICE] });
    await handleTool(USER, "set_booking_accounts", { fileId: "f-1", bookingAccounts: [] });

    expect(again).toMatchObject({ changed: false });
    const entries = await history("f-1");
    expect(entries.map((e) => [e.type, e.actor])).toEqual([
      ["booking_accounts_set", "ai"],
      ["booking_accounts_cleared", "ai"],
    ]);
    expect(entries[0].summary).toContain("7600");
  });

  it("fills the defaults, so an import may leave the optional fields out", async () => {
    await seedFile("f-1");

    await handleTool(USER, "set_booking_accounts", {
      fileId: "f-1",
      bookingAccounts: [{ accountNumber: "7600", accountName: "Büromaterial", origin: "sevdesk" }],
    });

    const file = (await handleTool(USER, "get_file", { fileId: "f-1" })) as Record<string, unknown>;
    expect(file.bookingAccounts).toEqual([
      {
        accountNumber: "7600",
        accountName: "Büromaterial",
        skr03: null,
        skr04: null,
        isAsset: false,
        isGwg: false,
        vatPercent: null,
        amount: null,
        origin: "sevdesk",
        externalId: null,
      },
    ]);
  });
});

describe("a Booking Account is not part of the Extraction", () => {
  it("is not a Hand Correction, and a re-extraction neither refuses the File nor clears the list", async () => {
    await seedFile("f-1", { extractedLineItems: [{ description: "Papier", amount: 12000, vatPercent: 20, vatAmount: 2000 }] });
    await handleTool(USER, "set_booking_accounts", { fileId: "f-1", bookingAccounts: [OFFICE] });

    const corrected = (await handleTool(USER, "list_files", { handCorrected: true })) as { files: unknown[] };
    expect(corrected.files).toEqual([]);

    await expect(handleTool(USER, "retry_file_extraction", { fileId: "f-1", force: true })).resolves.toMatchObject({
      queued: true,
    });
    const file = (await handleTool(USER, "get_file", { fileId: "f-1" })) as Record<string, unknown>;
    expect(file.extractionComplete).not.toBe(true); // the reset ran
    expect(file.bookingAccounts).toEqual([OFFICE]);
  });

  it("takes a credit note's negative gross", async () => {
    await seedFile("f-credit", { extractedAmount: -12000 });
    const refund = { ...OFFICE, amount: -12000 };

    await handleTool(USER, "set_booking_accounts", { fileId: "f-credit", bookingAccounts: [refund] });

    const file = (await handleTool(USER, "get_file", { fileId: "f-credit" })) as Record<string, unknown>;
    expect(file.bookingAccounts).toEqual([refund]);
  });
});

describe("set_booking_accounts refuses", () => {
  const set = (args: Record<string, unknown>) => handleTool(USER, "set_booking_accounts", args);

  it("both ids, or neither", async () => {
    await seedFile("f-1");
    await expect(set({ fileId: "f-1", transactionId: "t-1", bookingAccounts: [] })).rejects.toThrow(
      /exactly one of fileId or transactionId/
    );
    await expect(set({ bookingAccounts: [] })).rejects.toThrow(/exactly one of fileId or transactionId/);
  });

  it("a list that is not a list", async () => {
    await seedFile("f-1");
    await expect(set({ fileId: "f-1" })).rejects.toThrow(/bookingAccounts must be an array/);
  });

  it.each([
    ["a missing account number", { accountNumber: "" }, /accountNumber/],
    ["a numeric account number", { accountNumber: 7600 }, /accountNumber/],
    ["a missing account name", { accountName: " " }, /accountName/],
    ["a fractional amount", { amount: 12.5 }, /amount/],
    ["a VAT rate above 100", { vatPercent: 120 }, /vatPercent/],
    ["a non-boolean asset flag", { isAsset: "yes" }, /isAsset/],
    ["an unknown origin", { origin: "lexoffice" }, /origin/],
    ["origin manual, which only a person sets", { origin: "manual" }, /origin/],
  ])("%s, and stores nothing", async (_name, patch, message) => {
    await seedFile("f-1");
    await expect(set({ fileId: "f-1", bookingAccounts: [{ ...OFFICE, ...patch }] })).rejects.toThrow(message);
    const file = (await handleTool(USER, "get_file", { fileId: "f-1" })) as Record<string, unknown>;
    expect(file.bookingAccounts).toBeUndefined();
  });

  it("another User's File or Transaction, as not found", async () => {
    await seedFile("f-other", { userId: "someone-else" });
    await db.collection("transactions").doc("t-other").set({ userId: "someone-else", amount: -100, fileIds: [] });

    await expect(set({ fileId: "f-other", bookingAccounts: [OFFICE] })).rejects.toThrow(/File not found/);
    await expect(set({ transactionId: "t-other", bookingAccounts: [OFFICE] })).rejects.toThrow(
      /Transaction not found/
    );
    const other = await db.collection("files").doc("f-other").get();
    expect(other.data()?.bookingAccounts).toBeUndefined();
  });
});

describe("set_booking_accounts on a Transaction", () => {
  it("stores the list; get_transaction and list_transactions return it", async () => {
    await db.collection("transactions").doc("t-1").set({
      userId: USER,
      sourceId: "src-1",
      date: Timestamp.fromDate(new Date("2026-02-01T00:00:00.000Z")),
      amount: -1500,
      currency: "EUR",
      partner: "Bank",
      fileIds: [],
    });
    const fees = { ...OFFICE, accountNumber: "7780", accountName: "Bankspesen", vatPercent: null, amount: null };

    await handleTool(USER, "set_booking_accounts", { transactionId: "t-1", bookingAccounts: [fees] });

    const tx = (await handleTool(USER, "get_transaction", { transactionId: "t-1" })) as Record<string, unknown>;
    expect(tx.bookingAccounts).toEqual([fees]);
    const { transactions } = (await handleTool(USER, "list_transactions", {})) as {
      transactions: Array<Record<string, unknown>>;
    };
    expect(transactions.find((t) => t.id === "t-1")?.bookingAccounts).toEqual([fees]);

    const again = await handleTool(USER, "set_booking_accounts", { transactionId: "t-1", bookingAccounts: [fees] });
    expect(again).toMatchObject({ changed: false });
    await handleTool(USER, "set_booking_accounts", { transactionId: "t-1", bookingAccounts: [] });
    const cleared = (await handleTool(USER, "get_transaction", { transactionId: "t-1" })) as Record<string, unknown>;
    expect(cleared.bookingAccounts).toEqual([]);
    expect((cleared.automationHistory as Array<{ type: string }>).map((e) => e.type)).toEqual([
      "booking_accounts_set",
      "booking_accounts_cleared",
    ]);
  });
});
