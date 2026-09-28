/**
 * The Transaction side of the connect overlay (#243): each Transaction row
 * shows how many Files are already on it and, while it is not yet documented,
 * its Remainder. Nothing is hidden or disabled because a Transaction already
 * holds a File: that is exactly where a split part-invoice has to land.
 */

import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConnectResultRow } from "@/components/ui/connect-result-row";
import {
  coverageFromConnectedFiles,
  rowRemainder,
} from "@/lib/matching/connection-count";

function renderRow(props: Partial<React.ComponentProps<typeof ConnectResultRow>>) {
  const onClick = vi.fn();
  render(
    <TooltipProvider>
      <ConnectResultRow id="t1" title="Hetzner" onClick={onClick} {...props} />
    </TooltipProvider>
  );
  return { onClick, button: screen.getByRole("button") as HTMLButtonElement };
}

describe("rowRemainder", () => {
  it("prints the Remainder of a partly documented Transaction", () => {
    expect(
      rowRemainder({ remainder: 4000, isCovered: false, againstRemainder: true })
    ).toBe(4000);
  });

  it("prints nothing for a fully documented Transaction", () => {
    expect(
      rowRemainder({ remainder: 0, isCovered: true, againstRemainder: false })
    ).toBeNull();
    // Past COVERAGE_RATIO but not quite closed: documented, so no figure.
    expect(
      rowRemainder({ remainder: 500, isCovered: true, againstRemainder: true })
    ).toBeNull();
  });

  it("prints nothing without Coverage", () => {
    expect(rowRemainder(undefined)).toBeNull();
  });
});

describe("coverageFromConnectedFiles", () => {
  it("derives through the shared Coverage helpers, tip included", () => {
    const c = coverageFromConnectedFiles(-10000, [
      { extractedAmount: 5000, extractedTipAmount: 1000 },
    ]);
    expect(c?.remainder).toBe(4000);
    expect(c?.againstRemainder).toBe(true);
    expect(c?.isCovered).toBe(false);
  });

  it("is null when the connected Files explain nothing", () => {
    expect(coverageFromConnectedFiles(-10000, [{ extractedAmount: null }])).toBeNull();
    expect(coverageFromConnectedFiles(-10000, [])).toBeNull();
  });
});

describe("ConnectResultRow on the Transaction side", () => {
  it("shows '1 File' and the Remainder, and stays selectable", () => {
    const { button, onClick } = renderRow({
      connectionCount: 1,
      connectionNoun: "File",
      remainder: "40,00 €",
    });
    expect(screen.getByText("1 File")).toBeTruthy();
    expect(screen.getByText(/Remainder/)).toBeTruthy();
    expect(screen.getByText(/40,00 €/)).toBeTruthy();
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("shows the badge and no Remainder for a fully documented Transaction", () => {
    renderRow({ connectionCount: 2, connectionNoun: "File" });
    expect(screen.getByText("2 Files")).toBeTruthy();
    expect(screen.queryByText(/Remainder/)).toBeNull();
  });

  it("keeps the connected treatment for a row already on the File in hand", () => {
    const { button } = renderRow({
      isConnected: true,
      connectionCount: 1,
      connectionNoun: "File",
      remainder: "40,00 €",
    });
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.queryByText("1 File")).toBeNull();
    expect(screen.queryByText(/Remainder/)).toBeNull();
    expect(button.disabled).toBe(true);
  });
});
