/**
 * The Add cash payment dialog (#788): the User types a positive amount and
 * picks money out or money in, out preselected; the server is asked for
 * signed cents on the calendar day the User picked, through the
 * addCashPayment callable and nothing else.
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
    return { transactionId: "t-new", quotaExceeded: false };
  }),
}));
vi.mock("@/hooks/use-partners", () => ({
  usePartners: () => ({ partners: [{ id: "p-cafe", name: "Cafe Central" }] }),
}));

import { AddCashPaymentDialog } from "@/components/sources/add-cash-payment-dialog";

function open(onAdded = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AddCashPaymentDialog open onClose={() => {}} sourceId="s-cash" currency="EUR" onAdded={onAdded} />
    </NextIntlClientProvider>
  );
  return onAdded;
}

function fill(amount: string) {
  fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-07-06" } });
  fireEvent.change(screen.getByLabelText("Amount (EUR)"), { target: { value: amount } });
  fireEvent.change(screen.getByLabelText("What for"), { target: { value: "Parkschein" } });
}

beforeEach(() => {
  calls.length = 0;
});

describe("Add cash payment dialog", () => {
  it("preselects money out and sends a negative amount in cents", async () => {
    const onAdded = open();
    expect(screen.getByRole("radio", { name: "Money out" }).getAttribute("aria-checked")).toBe("true");
    fill("4,50");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      name: "addCashPayment",
      data: { sourceId: "s-cash", date: "2026-07-06", amount: -450, name: "Parkschein" },
    });
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("t-new"));
  });

  it("sends money in as a positive amount", async () => {
    open();
    fireEvent.click(screen.getByRole("radio", { name: "Money in" }));
    fill("20.00");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].data.amount).toBe(2000);
  });

  it("does not send an amount that is not a positive number", () => {
    open();
    fill("-4,50");
    expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
