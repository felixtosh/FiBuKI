/**
 * #237, #513: what a File is sits in the File detail panel's top block as a
 * Type dropdown, and the § 11 reasoning is the content of the info button on
 * its label.
 *
 * What the reasoning says comes from lib/documents/document-type-presentation.js,
 * which has its own node suite; these tests pin what the popover content
 * shows, and what the dropdown offers and reaches.
 */

import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/hooks/use-document-label", () => ({
  useDocumentLabel: () => (presentation: { label?: string }) => presentation.label ?? "",
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { FileTypeControl, Section11Reasoning } from "@/components/documents/section-11-details";
import type { DocumentTypeBasis } from "@/types/file";

const BASIS: DocumentTypeBasis = {
  reason: "receipt-designation",
  regime: "standard",
  grossTotal: 120_00,
  selfDesignation: "Zahlungsbestätigung",
  selfDesignationClass: "receipt",
  zeroVatReason: null,
  degraded: false,
};

function renderReasoning(props: Partial<React.ComponentProps<typeof Section11Reasoning>> = {}) {
  return render(
    <TooltipProvider>
      <Section11Reasoning
        documentType="receipt"
        basis={BASIS}
        missingElements={["supplier-vat-id", "invoice-number"]}
        {...props}
      />
    </TooltipProvider>
  );
}

describe("Section11Reasoning", () => {
  it("shows the verdict and exactly one sentence, answer first", () => {
    renderReasoning();
    expect(screen.getByText("Payment confirmation")).toBeTruthy();
    const sentences = screen.getAllByTestId("section-11-consequence");
    expect(sentences).toHaveLength(1);
    expect(sentences[0].textContent).toMatch(/^No input VAT \(Vorsteuer\), because /);
  });

  it("on a receipt, lists the missing elements in English with the German in brackets", () => {
    renderReasoning();
    expect(screen.getByText("Missing under § 11")).toBeTruthy();
    // Named in the list and again beside its citation.
    expect(screen.getAllByText("Supplier VAT ID").length).toBeGreaterThan(0);
    expect(screen.getByText("(UID-Nummer des liefernden Unternehmers)")).toBeTruthy();
    expect(screen.getAllByText("Sequential invoice number").length).toBeGreaterThan(0);
  });

  it("carries the basis and the citations, and never the supplier mail", () => {
    const { container } = renderReasoning();
    expect(screen.getByText("Result")).toBeTruthy();
    expect(container.textContent).toMatch(/§ 11 Abs 1 lit\. i/);
    // The paste-ready mail stays on the chase queue.
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
    expect(container.textContent).not.toMatch(/Bitte übermitteln/);
  });

  it("on an invoice and on an unknown File, lists no elements at all", () => {
    for (const documentType of ["invoice", "unknown", undefined] as const) {
      const { unmount } = renderReasoning({
        documentType,
        basis:
          documentType === "invoice"
            ? { ...BASIS, reason: "zero-vat-with-stated-regime", zeroVatReason: "reverse-charge" }
            : null,
      });
      expect(screen.queryByText("Missing under § 11")).toBeNull();
      expect(screen.queryByText("Supplier VAT ID")).toBeNull();
      unmount();
    }
  });
});

describe("FileTypeControl", () => {
  function renderControl(props: Partial<React.ComponentProps<typeof FileTypeControl>> = {}) {
    const onMarkAsNotInvoice = vi.fn();
    const onUnmarkAsNotInvoice = vi.fn();
    render(
      <FileTypeControl
        documentType="receipt"
        isNotInvoice={false}
        onMarkAsNotInvoice={onMarkAsNotInvoice}
        onUnmarkAsNotInvoice={onUnmarkAsNotInvoice}
        {...props}
      />
    );
    return { onMarkAsNotInvoice, onUnmarkAsNotInvoice };
  }

  it("shows the classifier's verdict as the selected type", () => {
    renderControl();
    expect(screen.getByRole("combobox").textContent).toBe("Payment confirmation");
  });

  it("shows 'Not a financial document' once the user marked it so", () => {
    renderControl({ documentType: "other", isNotInvoice: true });
    expect(screen.getByRole("combobox").textContent).toBe("Not a financial document");
  });

  it("cannot be changed while the File is being parsed", () => {
    renderControl({ disabled: true });
    expect(screen.getByRole("combobox").hasAttribute("disabled")).toBe(true);
  });

  it("says it is analyzing while classification runs, with no control", () => {
    renderControl({ classifying: true });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("Analyzing...")).toBeTruthy();
  });
});
