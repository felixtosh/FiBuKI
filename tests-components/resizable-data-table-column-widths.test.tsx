/**
 * Remembered column widths on the shared table (#674): read from localStorage
 * on first render, clamped to each column's limits, written only when a drag
 * ends or after a double-click auto-fit, and never fatal when storage refuses.
 *
 * jsdom has no layout, so the virtualizer renders no rows; the header and the
 * <colgroup> are all these tests need. The widths asserted are the ones the
 * table puts on its <col> elements, which is what decides the layout.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import type { ColumnDef } from "@tanstack/react-table";
import { ResizableDataTable } from "@/components/ui/data-table/resizable-data-table";

type Row = { id: string; name: string; amount: number };

const KEY = "fibuki.columnWidths.test";

const columns: ColumnDef<Row, unknown>[] = [
  { id: "select", header: "", size: 40, minSize: 40, maxSize: 40, enableResizing: false },
  { accessorKey: "name", header: "Name" },
  { accessorKey: "amount", header: "Amount", maxSize: 300 },
];
const defaultColumnSizes = { select: 40, name: 200, amount: 120 };

function renderTable({ withKey = true } = {}) {
  return render(
    <ResizableDataTable<Row>
      columns={columns}
      data={[{ id: "r1", name: "REWE", amount: 1234 }]}
      defaultColumnSizes={defaultColumnSizes}
      columnWidthsStorageKey={withKey ? KEY : undefined}
    />
  );
}

function colWidths(container: HTMLElement): string[] {
  // The last <col> is the unlabelled filler
  return Array.from(container.querySelectorAll("colgroup col"))
    .slice(0, -1)
    .map((col) => (col as HTMLElement).style.width);
}

function handleOf(container: HTMLElement, columnId: string): HTMLElement {
  const th = container.querySelector(`th[data-col-id="${columnId}"]`)!;
  return th.querySelector(".cursor-col-resize") as HTMLElement;
}

describe("ResizableDataTable remembered column widths", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("opens at the defaults when nothing is stored", () => {
    const { container } = renderTable();
    expect(colWidths(container)).toEqual(["40px", "200px", "120px"]);
  });

  it("opens at the stored widths, clamped, ignoring columns that no longer exist", () => {
    localStorage.setItem(KEY, JSON.stringify({ name: 10, amount: 999, select: 90, gone: 500 }));
    const { container } = renderTable();
    // name clamps up to the table's minimum (60), amount down to its maxSize,
    // the fixed select column stays fixed, and "gone" is ignored
    expect(colWidths(container)).toEqual(["40px", "60px", "300px"]);
  });

  it("writes once when a drag ends, never on each drag tick", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { container } = renderTable();
    const handle = handleOf(container, "name");

    fireEvent.mouseDown(handle, { clientX: 100, detail: 1 });
    fireEvent.mouseMove(document, { clientX: 120 });
    fireEvent.mouseMove(document, { clientX: 150 });
    fireEvent.mouseMove(document, { clientX: 180 });
    expect(setItem).not.toHaveBeenCalled();
    expect(colWidths(container)[1]).toBe("280px");

    fireEvent.mouseUp(document);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ name: 280 });
  });

  it("does not write for a click on the edge that resized nothing", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { container } = renderTable();
    fireEvent.mouseDown(handleOf(container, "name"), { clientX: 100, detail: 1 });
    fireEvent.mouseUp(document);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("keeps widths already stored when another column is resized", () => {
    localStorage.setItem(KEY, JSON.stringify({ amount: 250 }));
    const { container } = renderTable();
    fireEvent.mouseDown(handleOf(container, "name"), { clientX: 100, detail: 1 });
    fireEvent.mouseMove(document, { clientX: 110 });
    fireEvent.mouseUp(document);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ name: 210, amount: 250 });
    expect(colWidths(container)).toEqual(["40px", "210px", "250px"]);
  });

  it("keeps the stored width of a column this view does not show", () => {
    // e.g. the Files table's Deleted column, shown in the deleted-files view only
    localStorage.setItem(KEY, JSON.stringify({ deletedAt: 220 }));
    const { container } = renderTable();
    fireEvent.mouseDown(handleOf(container, "name"), { clientX: 100, detail: 1 });
    fireEvent.mouseMove(document, { clientX: 130 });
    fireEvent.mouseUp(document);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ deletedAt: 220, name: 230 });
  });

  it("writes after a double-click auto-fit", () => {
    localStorage.setItem(KEY, JSON.stringify({ name: 400 }));
    const { container } = renderTable();
    // jsdom measures every cell as 0 wide, so the fit lands on the default
    fireEvent.mouseDown(handleOf(container, "name"), { clientX: 100, detail: 2 });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ name: 200 });
    expect(colWidths(container)[1]).toBe("200px");
  });

  it("survives a remount, as across a reload", () => {
    const first = renderTable();
    fireEvent.mouseDown(handleOf(first.container, "amount"), { clientX: 100, detail: 1 });
    fireEvent.mouseMove(document, { clientX: 160 });
    fireEvent.mouseUp(document);
    first.unmount();

    const { container } = renderTable();
    expect(colWidths(container)).toEqual(["40px", "200px", "180px"]);
  });

  it("neither reads nor writes without a storage key", () => {
    localStorage.setItem(KEY, JSON.stringify({ name: 300 }));
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { container } = renderTable({ withKey: false });
    expect(colWidths(container)[1]).toBe("200px");
    fireEvent.mouseDown(handleOf(container, "name"), { clientX: 100, detail: 2 });
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("still renders and resizes when storage refuses (private window)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const { container } = renderTable();
    expect(colWidths(container)).toEqual(["40px", "200px", "120px"]);
    fireEvent.mouseDown(handleOf(container, "name"), { clientX: 100, detail: 1 });
    fireEvent.mouseMove(document, { clientX: 150 });
    expect(() => fireEvent.mouseUp(document)).not.toThrow();
    expect(colWidths(container)[1]).toBe("250px");
  });
});
