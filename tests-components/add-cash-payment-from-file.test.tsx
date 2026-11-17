/**
 * "Add as cash payment" from a File (#789): the add-payment dialog opens with
 * the File's figures for the User to check, picks the Cash Box (chosen when
 * there is one, asked when there are several, created when there is none),
 * and asks the server through addCashPaymentFromFile (after createSource, for
 * a first Cash Box) and nothing else.
 */

import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";

const calls = vi.hoisted(() => [] as Array<{ name: string; data: Record<string, unknown> }>);

vi.mock("@/lib/firebase/callable", () => ({
  callFunction: vi.fn(async (name: string, data: Record<string, unknown>) => {
    calls.push({ name, data });
    if (name === "createSource") return { sourceId: "s-new" };
    return { transactionId: "t-new", quotaExceeded: false, fileId: "f-cafe", connectionId: "f-cafe__t-new" };
  }),
}));
vi.mock("@/hooks/use-partners", () => ({
  usePartners: () => ({ partners: [{ id: "p-cafe", name: "Cafe Central" }] }),
}));

import { AddCashPaymentDialog } from "@/components/sources/add-cash-payment-dialog";
import { cashPaymentOffer } from "@/functions/src/transactions/cashPaymentDefaults";

const FILE = { fileId: "f-cafe", defaults: { date: "2026-07-06", amount: -900, name: "Cafe Central", partnerId: "p-cafe" } };
const KASSA = { id: "s-cash", name: "Kassa", currency: "EUR" };

function open(cashBoxes: Array<{ id: string; name: string; currency: string }>, onAdded = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AddCashPaymentDialog open onClose={() => {}} currency="EUR" fromFile={FILE} cashBoxes={cashBoxes} onAdded={onAdded} />
    </NextIntlClientProvider>
  );
  return onAdded;
}

beforeEach(() => {
  calls.length = 0;
});

describe("Add as cash payment, from a File", () => {
  it("opens with the File's day, amount, direction, name and Partner, and sends them for the File", async () => {
    const onAdded = open([KASSA]);
    expect((screen.getByLabelText("Date") as HTMLInputElement).value).toBe("2026-07-06");
    expect((screen.getByLabelText("Amount (EUR)") as HTMLInputElement).value).toBe("9,00");
    expect((screen.getByLabelText("What for") as HTMLInputElement).value).toBe("Cafe Central");
    expect(screen.getByRole("radio", { name: "Money out" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      name: "addCashPaymentFromFile",
      data: { fileId: "f-cafe", sourceId: "s-cash", date: "2026-07-06", amount: -900, name: "Cafe Central", partnerId: "p-cafe" },
    });
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("t-new"));
  });

  it("opens an outgoing invoice as money in", () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <AddCashPaymentDialog
          open
          onClose={() => {}}
          currency="EUR"
          fromFile={{ fileId: "f-sold", defaults: { date: "2026-07-06", amount: 12000, name: "Workshop", partnerId: null } }}
          cashBoxes={[KASSA]}
        />
      </NextIntlClientProvider>
    );
    expect(screen.getByRole("radio", { name: "Money in" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("Amount (EUR)") as HTMLInputElement).value).toBe("120,00");
  });

  it("sends what the User corrected instead of the File's figures", async () => {
    open([KASSA]);
    fireEvent.change(screen.getByLabelText("Amount (EUR)"), { target: { value: "10,50" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].data.amount).toBe(-1050);
  });

  it("asks which Cash Box when there are several, and waits for the choice", () => {
    open([KASSA, { id: "s-graz", name: "Kassa Graz", currency: "EUR" }]);
    expect(screen.getByText("Cash box")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("with no Cash Box, says one will be created and creates it through createSource first", async () => {
    open([]);
    expect(screen.getByText(/No cash box yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]).toEqual({
      name: "createSource",
      data: { data: { name: "Cash", accountKind: "cash", currency: "EUR", type: "manual" } },
    });
    expect(calls[1].name).toBe("addCashPaymentFromFile");
    expect(calls[1].data.sourceId).toBe("s-new");
  });
});

describe("where the File detail panel offers it", () => {
  it("promotes it on a cash receipt, offers it on any other unconnected File, and hides it otherwise", () => {
    const cash = { extractedAdditionalFields: [{ key: "paymentMethod", value: "cash" }], transactionIds: [] };
    expect(cashPaymentOffer(cash)).toBe("promoted");
    expect(cashPaymentOffer({ transactionIds: [] })).toBe("offered");
    expect(cashPaymentOffer({ ...cash, transactionIds: ["t-1"] })).toBeNull();
    expect(cashPaymentOffer({ ...cash, deletedAt: new Date() })).toBeNull();
    expect(cashPaymentOffer({ ...cash, copyOfFileId: "f-original" })).toBeNull();
  });
});
