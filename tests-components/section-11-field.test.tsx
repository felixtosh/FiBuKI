/**
 * #237, #513, #519: the § 11 reasoning is the content of the info button on
 * the File detail panel's "VAT deductible" label.
 *
 * What the reasoning says comes from lib/documents/document-type-presentation.js,
 * which has its own node suite; these tests pin what the popover content
 * shows.
 */

import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/hooks/use-document-label", () => ({
  useDocumentLabel: () => (presentation: { label?: string }) => presentation.label ?? "",
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { Section11Reasoning } from "@/components/documents/section-11-details";
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
