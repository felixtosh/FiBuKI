/**
 * #342: a refused correction used to be swallowed. The panel caught the
 * callable's error into the console and the editor closed regardless, so the
 * typed value vanished and nothing said why.
 *
 * FileExtractedInfo is rendered on its own with `onUpdate` standing in for the
 * panel's handler, which now rethrows. The messages are the callable's own
 * refusal texts (functions/src/files/extractionCorrectionOps.ts, tipBound.ts),
 * copied rather than imported: this suite resolves from the root tree and
 * functions/ is not part of it.
 */

import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

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
  fileName: "restaurant.pdf",
  extractionComplete: true,
  extractionError: null,
  isNotInvoice: false,
  extractedAmount: 4000,
  extractedCurrency: "EUR",
  extractedPartner: "Gasthaus",
} as unknown as TaxFile;

const REFUSALS = [
  // #310's bound, the case that made this the common path.
  "tipAmount 600.00 must be less than the document total it is measured against, 40.00.",
  "tipAmount must not be negative",
  "date must be an ISO date string, YYYY-MM-DD",
  "vatPercent must be a number between 0 and 100",
];

function renderPanel(onUpdate: (fields: unknown) => Promise<void>) {
  render(<FileExtractedInfo file={FILE} onUpdate={onUpdate} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit fields" }));
  const tip = screen.getByPlaceholderText("Trinkgeld in EUR") as HTMLInputElement;
  fireEvent.change(tip, { target: { value: "600" } });
  fireEvent.click(screen.getByRole("button", { name: "Update" }));
}

describe("FileExtractedInfo, when a correction is refused (#342)", () => {
  it.each(REFUSALS)("shows the callable's message and keeps the editor open: %s", async (message) => {
    const onUpdate = vi.fn().mockRejectedValue(new Error(message));
    renderPanel(onUpdate);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(message);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // Still editing, with what was typed.
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect((screen.getByPlaceholderText("Trinkgeld in EUR") as HTMLInputElement).value).toBe("600");
  });

  it("surfaces an unexpected failure as a failure, not as a success", async () => {
    renderPanel(vi.fn().mockRejectedValue(new Error("")));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("could not be saved");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("clears the refusal once the retry succeeds, and closes the editor as before", async () => {
    const onUpdate = vi
      .fn()
      .mockRejectedValueOnce(new Error(REFUSALS[0]))
      .mockResolvedValueOnce(undefined);
    renderPanel(onUpdate);
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it("a save that succeeds closes the editor exactly as it does today", async () => {
    renderPanel(vi.fn().mockResolvedValue(undefined));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
