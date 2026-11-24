/**
 * #785: the Booking Accounts an import stored, shown read-only in the File and
 * Transaction panels. An item without any looks as it always did.
 */

import * as React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import de from "@/messages/de.json";
import { BookingAccountsSection } from "@/components/files/booking-accounts-section";
import type { BookingAccount } from "@/functions/src/bookingAccounts/types";

const MACHINE: BookingAccount = {
  accountNumber: "0620",
  accountName: "Büromaschinen",
  skr03: "0420",
  skr04: null,
  isAsset: true,
  isGwg: false,
  vatPercent: 20,
  amount: 120000,
  origin: "sevdesk",
  externalId: "acc-1",
};

function renderIn(locale: "en" | "de", bookingAccounts?: BookingAccount[]) {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : de}>
      <BookingAccountsSection bookingAccounts={bookingAccounts} />
    </NextIntlClientProvider>
  );
}

describe("BookingAccountsSection", () => {
  it("renders nothing without Booking Accounts", () => {
    expect(renderIn("en").container.innerHTML).toBe("");
    expect(renderIn("en", []).container.innerHTML).toBe("");
  });

  it("shows each account with its flags, rate, other charts and origin", () => {
    renderIn("en", [MACHINE]);
    expect(screen.getByText("Booking accounts")).toBeTruthy();
    expect(screen.getByText("0620")).toBeTruthy();
    expect(screen.getByText("Büromaschinen")).toBeTruthy();
    expect(screen.getByText("Fixed asset")).toBeTruthy();
    expect(screen.queryByText("Low-value asset")).toBeNull();
    expect(screen.getByText("20% VAT")).toBeTruthy();
    expect(screen.getByText("Other charts: SKR03 0420")).toBeTruthy();
    expect(screen.getByText("From SevDesk")).toBeTruthy();
    expect(screen.getByText(/1\.200,00/)).toBeTruthy();
  });

  it("speaks the Tax Advisor's German", () => {
    renderIn("de", [{ ...MACHINE, isAsset: false, isGwg: true }]);
    expect(screen.getByText("Sachkonten")).toBeTruthy();
    expect(screen.getByText("GWG")).toBeTruthy();
    expect(screen.getByText("Aus SevDesk")).toBeTruthy();
  });
});
