/**
 * Correct and Delete on a hand-added Cash Payment (#790): the dialog starts
 * from the stored row, sends signed cents on the chosen day through
 * correctCashPayment, and a delete goes through deleteCashPayment; a refusal
 * from the server (a filed UVA period) is shown as it comes.
 */

import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";

const calls = vi.hoisted(() => [] as Array<{ name: string; data: Record<string, unknown> }>);
const refuse = vi.hoisted(() => ({ message: null as string | null }));

vi.mock("@/lib/firebase/callable", () => ({
  callFunction: vi.fn(async (name: string, data: Record<string, unknown>) => {
    calls.push({ name, data });
    if (refuse.message) throw new Error(refuse.message);
    return name === "deleteCashPayment" ? { deleted: true, filesDisconnected: 0 } : { changed: true };
  }),
}));

import { CashPaymentActions } from "@/components/transactions/cash-payment-actions";
import type { Transaction } from "@/types/transaction";

const row = {
  id: "t-cash",
  date: { toDate: () => new Date("2026-07-06T00:00:00Z") },
  amount: -450,
  currency: "EUR",
  name: "Parkschien",
  description: null,
  fileIds: ["f-1"],
  addedByHand: true,
} as unknown as Transaction;

function show(onDeleted = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <CashPaymentActions transaction={row} onDeleted={onDeleted} />
    </NextIntlClientProvider>
  );
  return onDeleted;
}

beforeEach(() => {
  calls.length = 0;
  refuse.message = null;
});

describe("Correct a cash payment", () => {
  it("starts from the stored row and sends the corrected day and signed cents", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Correct" }));

    expect((screen.getByLabelText("Date") as HTMLInputElement).value).toBe("2026-07-06");
    expect((screen.getByLabelText("Amount (EUR)") as HTMLInputElement).value).toBe("4,50");
    expect(screen.getByRole("radio", { name: "Money out" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.change(screen.getByLabelText("Amount (EUR)"), { target: { value: "5,40" } });
    fireEvent.change(screen.getByLabelText("What for"), { target: { value: "Parkschein" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      name: "correctCashPayment",
      data: { transactionId: "t-cash", date: "2026-07-06", amount: -540, name: "Parkschein", description: null },
    });
  });

  it("shows the server's refusal for a filed period", async () => {
    refuse.message = "The UVA for 2026-Q3 is already filed, so a Cash Payment in it cannot be corrected.";
    show();
    fireEvent.click(screen.getByRole("button", { name: "Correct" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/2026-Q3 is already filed/)).toBeTruthy();
  });
});

describe("Delete a cash payment", () => {
  it("asks first, names the documents that stay, then deletes through deleteCashPayment", async () => {
    const onDeleted = show();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText(/document stays/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls).toEqual([{ name: "deleteCashPayment", data: { transactionId: "t-cash" } }]));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  });
});
