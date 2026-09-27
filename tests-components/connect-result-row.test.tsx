/**
 * The shared connect-overlay row and its Connection-count badge (#241).
 *
 * In the overlay that finds a File for a Transaction, a File already connected
 * to a different Transaction used to look identical to a free one. The row now
 * carries a count of the Connections it already has elsewhere. It is a count,
 * never a gate: a File legitimately belongs to two Transactions in a split
 * payment, so the row stays enabled.
 */

import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConnectResultRow } from "@/components/ui/connect-result-row";
import {
  connectionCountLabel,
  isConnectCandidateFile,
  otherConnectionCount,
} from "@/lib/matching/connection-count";

function renderRow(props: Partial<React.ComponentProps<typeof ConnectResultRow>>) {
  const onClick = vi.fn();
  render(
    <TooltipProvider>
      <ConnectResultRow id="r1" title="invoice.pdf" onClick={onClick} {...props} />
    </TooltipProvider>
  );
  return { onClick, button: screen.getByRole("button") };
}

describe("otherConnectionCount", () => {
  it("counts Connections to anything but the item in hand", () => {
    expect(otherConnectionCount(["tx-a"], "tx-hand")).toBe(1);
    expect(otherConnectionCount(["tx-a", "tx-hand"], "tx-hand")).toBe(1);
    expect(otherConnectionCount(["tx-hand"], "tx-hand")).toBe(0);
    expect(otherConnectionCount([], "tx-hand")).toBe(0);
    expect(otherConnectionCount(undefined, "tx-hand")).toBe(0);
  });

  it("does not count a duplicated id twice", () => {
    expect(otherConnectionCount(["tx-a", "tx-a", "tx-b"], null)).toBe(2);
  });
});

describe("isConnectCandidateFile", () => {
  it("offers a File already connected to another Transaction", () => {
    expect(isConnectCandidateFile({ isNotInvoice: false })).toBe(true);
    expect(isConnectCandidateFile({})).toBe(true);
  });

  it("still leaves out a File marked as not an invoice", () => {
    expect(isConnectCandidateFile({ isNotInvoice: true })).toBe(false);
  });
});

describe("connectionCountLabel", () => {
  it("pluralises the noun", () => {
    expect(connectionCountLabel(1, "Transaction")).toBe("1 Transaction");
    expect(connectionCountLabel(2, "Transaction")).toBe("2 Transactions");
    expect(connectionCountLabel(1, "File")).toBe("1 File");
    expect(connectionCountLabel(3, "File")).toBe("3 Files");
  });
});

describe("ConnectResultRow connection-count badge", () => {
  it("shows '1 Transaction' on a File connected elsewhere, and stays selectable", () => {
    const { button, onClick } = renderRow({
      connectionCount: 1,
      connectionNoun: "Transaction",
    });
    expect(screen.getByText("1 Transaction")).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("pluralises for two Connections", () => {
    renderRow({ connectionCount: 2, connectionNoun: "Transaction" });
    expect(screen.getByText("2 Transactions")).toBeTruthy();
  });

  it("shows no badge when the File has no Connections", () => {
    renderRow({ connectionCount: 0, connectionNoun: "Transaction" });
    expect(screen.queryByText(/Transaction/)).toBeNull();
  });

  it("keeps the connected treatment for a row connected to the item in hand", () => {
    const { button } = renderRow({
      isConnected: true,
      connectionCount: 0,
      connectionNoun: "Transaction",
    });
    expect(screen.getByText("Connected")).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders no badge at all when no count is passed", () => {
    renderRow({});
    expect(screen.queryByTestId("connection-count-badge")).toBeNull();
  });
});
