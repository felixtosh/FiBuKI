/**
 * #519: Type is one field on the File detail panel for what a File is and
 * which way it goes: Income, Expense or Not an invoice, "Not determined"
 * before the direction is known, and the § 11 verdict as "VAT deductible".
 */

import * as React from "react";
import { describe, expect, it } from "vitest";
import { render, renderHook, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "@/messages/en.json";
import { FileKindControl, useVatDeductible } from "@/components/files/file-direction-control";
import type { TaxFile } from "@/types/file";

const file = (overrides: Partial<TaxFile> = {}) =>
  ({ id: "f1", fileName: "a.pdf", isNotInvoice: false, invoiceDirection: "incoming", ...overrides }) as TaxFile;

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <NextIntlClientProvider locale="en" messages={messages} timeZone="Europe/Vienna">
    {children}
  </NextIntlClientProvider>
);

function renderControl(props: Partial<React.ComponentProps<typeof FileKindControl>> & { file?: TaxFile } = {}) {
  render(<FileKindControl file={props.file ?? file()} {...props} />, { wrapper });
}

describe("FileKindControl", () => {
  it("reads an incoming File as Expense and an outgoing one as Income", () => {
    renderControl();
    expect(screen.getByRole("combobox").textContent).toBe("Expense");
  });

  it("reads an outgoing File as Income", () => {
    renderControl({ file: file({ invoiceDirection: "outgoing" }) });
    expect(screen.getByRole("combobox").textContent).toBe("Income");
  });

  it("reads a File marked not a financial document as Not an invoice", () => {
    renderControl({ file: file({ isNotInvoice: true }) });
    expect(screen.getByRole("combobox").textContent).toBe("Not an invoice");
  });

  it("says Not determined while the direction is unknown, never a guess", () => {
    renderControl({ file: file({ invoiceDirection: "unknown" }) });
    expect(screen.getByRole("combobox").textContent).toBe("Not determined");
  });

  it("says Analyzing... with no control while classification runs", () => {
    renderControl({ classifying: true });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("Analyzing...")).toBeTruthy();
  });
});

describe("useVatDeductible", () => {
  const verdict = (documentType: TaxFile["documentType"]) =>
    renderHook(() => useVatDeductible(file({ documentType })), { wrapper }).result.current;

  it("says yes for a § 11 invoice and no for a payment confirmation", () => {
    expect(verdict("invoice")).toEqual({ text: "Yes", tone: "yes" });
    expect(verdict("receipt")).toEqual({ text: "No, ask the supplier for an invoice", tone: "no" });
  });

  it("says not determined for anything else", () => {
    expect(verdict("unknown").tone).toBe("unknown");
    expect(verdict(undefined).tone).toBe("unknown");
  });
});
