/**
 * #237: the § 11 field on the File detail panel is one control, leads with the
 * consequence, and keeps its reasoning behind a click.
 *
 * Section11Field is rendered on its own with the two override callbacks the
 * panel passes through. What the field says comes from
 * lib/documents/document-type-presentation.js, which has its own node suite;
 * these tests pin what the FIELD shows at rest, what it hides, and which
 * callback its one control reaches.
 */

import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@/hooks/use-document-label", () => ({
  useDocumentLabel: () => (presentation: { label?: string }) => presentation.label ?? "",
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { Section11Field } from "@/components/documents/section-11-details";
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

function renderField(props: Partial<React.ComponentProps<typeof Section11Field>> = {}) {
  const onMarkAsNotInvoice = vi.fn();
  const onUnmarkAsNotInvoice = vi.fn();
  const utils = render(
    <TooltipProvider>
      <Section11Field
        documentType="receipt"
        basis={BASIS}
        missingElements={["supplier-vat-id", "invoice-number"]}
        isNotInvoice={false}
        onMarkAsNotInvoice={onMarkAsNotInvoice}
        onUnmarkAsNotInvoice={onUnmarkAsNotInvoice}
        {...props}
      />
    </TooltipProvider>
  );
  return { ...utils, onMarkAsNotInvoice, onUnmarkAsNotInvoice };
}

describe("Section11Field at rest", () => {
  it("shows the verdict and exactly one sentence, answer first", () => {
    renderField();
    const field = screen.getByRole("region", { name: /§ 11/ });

    expect(within(field).getByText("Payment confirmation")).toBeTruthy();
    const sentences = within(field).getAllByTestId("section-11-consequence");
    expect(sentences).toHaveLength(1);
    expect(sentences[0].textContent).toMatch(/^No input VAT \(Vorsteuer\), because /);
  });

  it("hides the basis, the citations and the supplier mail", () => {
    renderField();
    const field = screen.getByRole("region", { name: /§ 11/ });

    // The basis lines' labels and the regime text are not in the DOM at rest.
    expect(within(field).queryByText("Verdict")).toBeNull();
    expect(within(field).queryByText(/§ 11 Abs 1 applies above/)).toBeNull();
    // No paragraph citation visible at rest.
    expect(field.textContent).not.toMatch(/Abs \d|lit\./);
    // The paste-ready mail stays on the chase queue.
    expect(within(field).queryByRole("button", { name: /copy/i })).toBeNull();
    expect(field.textContent).not.toMatch(/Bitte übermitteln/);
  });

  it("on a receipt, lists the missing elements in English with the German in brackets", () => {
    renderField();
    const field = screen.getByRole("region", { name: /§ 11/ });
    expect(within(field).getByText("Missing under § 11")).toBeTruthy();
    expect(within(field).getByText("Supplier VAT ID")).toBeTruthy();
    expect(within(field).getByText("(UID-Nummer des liefernden Unternehmers)")).toBeTruthy();
    expect(within(field).getByText("Sequential invoice number")).toBeTruthy();
  });

  it("on an invoice and on an unknown File, lists no elements at all", () => {
    for (const documentType of ["invoice", "unknown", undefined] as const) {
      const { unmount } = renderField({
        documentType,
        basis:
          documentType === "invoice"
            ? { ...BASIS, reason: "zero-vat-with-stated-regime", zeroVatReason: "reverse-charge" }
            : null,
      });
      const field = screen.getByRole("region", { name: /§ 11/ });
      expect(within(field).queryByText("Missing under § 11")).toBeNull();
      expect(within(field).queryByText("Supplier VAT ID")).toBeNull();
      unmount();
    }
  });
});

describe("Section11Field reasoning", () => {
  it("expands on click and collapses again, from a real button", () => {
    renderField();
    const toggle = screen.getByRole("button", { name: /how this was decided/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(panel).toBeTruthy();
    expect(within(panel!).getByText("Verdict")).toBeTruthy();
    // Citations live here now.
    expect(panel!.textContent).toMatch(/§ 11 Abs 1 lit\. i/);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Verdict")).toBeNull();
  });
});

describe("Section11Field control", () => {
  it("is the only control, and it reaches 'not a document' and no further", () => {
    const { onMarkAsNotInvoice, onUnmarkAsNotInvoice } = renderField();
    const field = screen.getByRole("region", { name: /§ 11/ });

    // Nothing offers to mark a File as satisfying § 11.
    expect(within(field).queryByRole("combobox")).toBeNull();
    expect(within(field).queryByRole("option", { name: /invoice/i })).toBeNull();
    const controls = within(field).getAllByRole("switch");
    expect(controls).toHaveLength(1);
    expect(controls[0].getAttribute("aria-checked")).toBe("false");

    fireEvent.click(controls[0]);
    // The same handler the old "Not Invoice" option called, so the stored
    // result cannot move.
    expect(onMarkAsNotInvoice).toHaveBeenCalledTimes(1);
    expect(onUnmarkAsNotInvoice).not.toHaveBeenCalled();
  });

  it("undoes the user's own 'not a document' through the old unmark handler", () => {
    const { onMarkAsNotInvoice, onUnmarkAsNotInvoice } = renderField({
      documentType: "other",
      isNotInvoice: true,
      missingElements: [],
      basis: { ...BASIS, reason: "not-a-financial-document" },
    });
    const control = screen.getByRole("switch");
    expect(control.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(control);
    expect(onUnmarkAsNotInvoice).toHaveBeenCalledTimes(1);
    expect(onMarkAsNotInvoice).not.toHaveBeenCalled();
  });

  it("cannot be flipped while the File is being parsed", () => {
    const { onMarkAsNotInvoice } = renderField({ disabled: true });
    const control = screen.getByRole("switch");
    fireEvent.click(control);
    expect(onMarkAsNotInvoice).not.toHaveBeenCalled();
  });
});
