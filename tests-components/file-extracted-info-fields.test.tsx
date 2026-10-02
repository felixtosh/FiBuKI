/**
 * #540: the editor keeps a line item's numbers coupled, refuses a row no rate
 * can produce, and names extracted fields by key in the person's language,
 * with older keyless rows shown apart.
 */

import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import de from "@/messages/de.json";

vi.mock("@/lib/currency", () => ({
  useEcbConverter: () => ({ convert: () => null }),
}));
vi.mock("@/hooks/use-document-label", () => ({
  useDocumentLabel: () => (presentation: { label?: string }) => presentation.label ?? "",
}));

import { FileExtractedInfo } from "@/components/files/file-extracted-info";
import type { TaxFile } from "@/types/file";

const FILE = {
  id: "file-1",
  fileName: "bar.pdf",
  extractionComplete: true,
  extractionError: null,
  isNotInvoice: false,
  extractedAmount: 2680,
  extractedCurrency: "EUR",
  extractedPartner: "Needle Vinyl Bar",
  extractedCountry: "AT",
  extractedLineItems: [{ description: "Tacos", vatPercent: 10, vatAmount: 244, amount: 2680 }],
  extractedAdditionalFields: [
    { key: "paymentMethod", label: "Zahlungsart", value: "cash", rawValue: "Barzahlung" },
    { label: "Tisch", value: "5", rawValue: "5" },
  ],
} as unknown as TaxFile;

function renderPanel(locale: "en" | "de" = "en", onUpdate = vi.fn().mockResolvedValue(undefined)) {
  render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : de} timeZone="Europe/Vienna">
      <FileExtractedInfo file={FILE} onUpdate={onUpdate} />
    </NextIntlClientProvider>
  );
  return onUpdate;
}

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe("FileExtractedInfo line items (#540)", () => {
  it("recomputes the VAT amount when the rate changes, and the rate when the VAT changes", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Edit fields" }));

    fireEvent.change(input("VAT %"), { target: { value: "20" } });
    expect(input("VAT amount").value).toBe("4.47");

    fireEvent.change(input("VAT amount"), { target: { value: "2.44" } });
    expect(input("VAT %").value).toBe("10");

    fireEvent.change(input("Gross amount"), { target: { value: "13.20" } });
    expect(input("VAT amount").value).toBe("1.20");
  });

  it("refuses to save a row whose VAT is not inside its amount", () => {
    const onUpdate = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Edit fields" }));

    fireEvent.change(input("VAT amount"), { target: { value: "39.30" } });
    expect(screen.getByText(/must be smaller than the gross amount/)).toBeTruthy();
    const update = screen.getByRole("button", { name: "Update" }) as HTMLButtonElement;
    expect(update.disabled).toBe(true);
    fireEvent.click(update);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("warns about, but saves, a rate above every EU rate", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Edit fields" }));

    fireEvent.change(input("VAT %"), { target: { value: "39.3" } });
    expect(screen.getByText(/No EU country charges more than 27 %/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Update" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("FileExtractedInfo extracted fields (#540)", () => {
  it("names a keyed field and its value in the person's language", () => {
    renderPanel("de");
    fireEvent.click(screen.getByRole("button", { name: /Show more|Mehr/ }));
    expect(screen.getByText("Zahlungsart")).toBeTruthy();
    expect(screen.getByText("Bar")).toBeTruthy();
    expect(screen.getByText("Land")).toBeTruthy();
  });

  it("shows a keyless row from an older extraction apart, under its printed label", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Show more/ }));
    expect(screen.getByText("Payment method")).toBeTruthy();
    expect(screen.getByText("Cash")).toBeTruthy();
    expect(screen.getByText("Other (older extraction)")).toBeTruthy();
    expect(screen.getByText("Tisch")).toBeTruthy();
  });

  it("offers a field picker instead of a free label box", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Edit fields" }));
    expect(screen.queryByPlaceholderText("Label")).toBeNull();
    expect(screen.getByText("Add field")).toBeTruthy();
  });
});
