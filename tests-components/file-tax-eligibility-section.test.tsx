/**
 * The § 12 finding moved out of Extracted Information into its own section
 * below Transaction. It used to tell the User to "confirm it" with nothing to
 * click; the section now carries the confirm, through the
 * confirmFileRecipientIsUser callable (the ruling the AI tools already had).
 */

import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "@/messages/en.json";

const callFunction = vi.fn(async (..._args: unknown[]) => ({ success: true }));
vi.mock("@/lib/firebase/callable", () => ({ callFunction: (...args: unknown[]) => callFunction(...args) }));
vi.mock("@/hooks/use-document-label", () => ({
  useDocumentLabel: () => (presentation: { label?: string }) => presentation.label ?? "",
}));

import { FileTaxEligibilitySection } from "@/components/files/file-tax-eligibility-section";
import type { TaxFile } from "@/types/file";

function renderSection(file: Partial<TaxFile>) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <FileTaxEligibilitySection file={{ id: "file-1", ...file } as TaxFile} />
    </NextIntlClientProvider>
  );
}

describe("FileTaxEligibilitySection", () => {
  it("renders nothing for a File without a finding", () => {
    const { container } = renderSection({ foreignRecipient: false } as Partial<TaxFile>);
    expect(container.textContent).toBe("");
  });

  it("shows the § 12 finding in one line and confirms the recipient from the button", async () => {
    renderSection({ foreignRecipient: true } as Partial<TaxFile>);
    expect(screen.getByText("Tax eligibility")).toBeTruthy();
    expect(screen.getByText("Not addressed to you")).toBeTruthy();
    // The explanation is behind the info icon, not in the panel.
    expect(screen.queryByText(/§ 12 Abs 1 Z 1/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Yes, that's me" }));
    await waitFor(() => expect(callFunction).toHaveBeenCalledWith("confirmFileRecipientIsUser", { fileId: "file-1" }));
  });
});
