/**
 * VirtualRow's memo contract.
 *
 * components/ui/data-table/virtual-row.tsx wraps its row in React.memo with a
 * hand-written comparator. That comparator is the hot path of every table in
 * the product: it decides, for each of potentially thousands of rows, whether a
 * parent re-render reaches the row's cells.
 *
 * The comparator watches `row`, `rowStateKey`, `row.original.updatedAt`,
 * `isSelected`, `isPrimarySelected`, `virtualStart`, `virtualSize`, `className`
 * and the contents of `columnSizes`. It deliberately does NOT watch `onClick`
 * or `dataAttributes` — a fresh `onClick` identity on every parent render is
 * the normal case, and letting it through would defeat the memo entirely.
 *
 * That "deliberately ignores onClick" half is load-bearing and invisible: it is
 * a property of an inequality that isn't written down, so nothing stops a later
 * edit from adding `prevProps.onClick === nextProps.onClick` to the return
 * expression and silently turning every table back into a full re-render per
 * keystroke. These tests pin it.
 *
 * They are written against the component as it stands on main, and they stay
 * true after the useLatestCallback work (#298 / PR #337) lands: that change
 * exists precisely so the handler can be kept fresh WITHOUT the memo having to
 * watch it, so "changing only onClick must not re-render" is the invariant it
 * has to preserve, not one it breaks.
 *
 * What these tests do NOT assert: that clicking a row after `onClick` changed
 * calls the NEW handler. On main it calls the old one — `handleClick` closes
 * over the `onClick` from the last render that got through the memo. That is
 * the stale-closure bug #298 fixes, so asserting either way here would be
 * wrong: asserting the stale call encodes a bug as a contract, and asserting
 * the fresh call fails on main. Once #337 merges, the freshness assertion is
 * the obvious test to add to this file.
 */

import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import {
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";

import { VirtualRow } from "@/components/ui/data-table/virtual-row";
import type { RowClickModifiers } from "@/components/ui/data-table/types";

type TestRow = { id: string; name: string; updatedAt?: string };

/**
 * Module-level constants, not literals in the harness. useReactTable's core row
 * model is memoised on the identity of `data`, so a fresh array per render
 * would hand VirtualRow a new `row` object every time and the comparator's very
 * first check (`prevProps.row !== nextProps.row`) would short-circuit to
 * "re-render" — every test below would pass or fail for the wrong reason.
 */
const DATA: TestRow[] = [
  { id: "row-1", name: "invoice.pdf", updatedAt: "2026-01-01T00:00:00.000Z" },
];

/**
 * How we observe a component we are not allowed to instrument. VirtualRow is
 * memoised, so when the comparator returns true its subtree — including this
 * cell renderer — is never invoked again. flexRender renders a function
 * `cell` as a component, and this one is not memoised, so it runs on every
 * VirtualRow render and on no others. The counter is therefore an exact
 * render count for VirtualRow's body.
 */
let cellRenders = 0;

const COLUMNS: ColumnDef<TestRow, unknown>[] = [
  {
    id: "name",
    accessorKey: "name",
    cell: (ctx) => {
      cellRenders += 1;
      return <span data-testid="name-cell">{String(ctx.getValue())}</span>;
    },
  },
];

const noop = () => {};

interface HarnessProps {
  onClick?: (row: TestRow, modifiers: RowClickModifiers) => void;
  isSelected?: boolean;
  isPrimarySelected?: boolean;
  virtualStart?: number;
  virtualSize?: number;
  columnSizes?: number[];
  className?: string;
  dataAttributes?: Record<string, string>;
  rowStateKey?: string | number | boolean;
}

/**
 * Renders VirtualRow with a REAL TanStack row object, not a hand-rolled stub.
 * The comparator reads `row.original`, and the component calls
 * `row.getVisibleCells()` and feeds the result through `flexRender`, so a fake
 * row would either need most of the Row interface reimplemented or would quietly
 * bypass the code path under test.
 *
 * The <table>/<tbody> wrapper is required: VirtualRow renders a <tr>, and jsdom
 * follows the HTML parser's table rules, so a bare <tr> would be dropped.
 */
function Harness(props: HarnessProps) {
  const table = useReactTable({
    data: DATA,
    columns: COLUMNS,
    getCoreRowModel: getCoreRowModel(),
  });
  const row = table.getRowModel().rows[0];

  return (
    <table>
      <tbody>
        <VirtualRow<TestRow>
          row={row}
          isSelected={props.isSelected ?? false}
          isPrimarySelected={props.isPrimarySelected}
          onClick={props.onClick ?? noop}
          virtualStart={props.virtualStart ?? 0}
          virtualSize={props.virtualSize ?? 40}
          columnSizes={props.columnSizes ?? [200]}
          className={props.className}
          dataAttributes={props.dataAttributes}
          rowStateKey={props.rowStateKey}
        />
      </tbody>
    </table>
  );
}

function renderHarness(props: HarnessProps = {}) {
  cellRenders = 0;
  const utils = render(<Harness {...props} />);
  return {
    ...utils,
    rerenderHarness: (next: HarnessProps) =>
      utils.rerender(<Harness {...next} />),
    renderCount: () => cellRenders,
  };
}

describe("VirtualRow rendering", () => {
  it("renders one cell per visible column, with the row's identity on the <tr>", () => {
    const { container, getByTestId, renderCount } = renderHarness();

    const tr = container.querySelector("tr");
    expect(tr).not.toBeNull();
    expect(tr!.getAttribute("data-row-id")).toBe("row-1");
    expect(tr!.querySelectorAll("td")).toHaveLength(1);
    expect(getByTestId("name-cell").textContent).toBe("invoice.pdf");
    // Proves the counter is wired to a real render, so a later assertion of
    // "the count did not change" means something.
    expect(renderCount()).toBe(1);
  });

  it("projects dataAttributes onto the <tr> as data-* attributes", () => {
    const { container } = renderHarness({
      dataAttributes: { searching: "true", kind: "receipt" },
    });

    const tr = container.querySelector("tr")!;
    expect(tr.getAttribute("data-searching")).toBe("true");
    expect(tr.getAttribute("data-kind")).toBe("receipt");
  });

  it("marks the row selected via data-state", () => {
    const { container } = renderHarness({ isSelected: true });
    expect(container.querySelector("tr")!.getAttribute("data-state")).toBe(
      "selected"
    );
  });

  it("reports the clicked row and its modifier keys", () => {
    const onClick = vi.fn();
    const { container } = renderHarness({ onClick });

    fireEvent.click(container.querySelector("tr")!, {
      shiftKey: true,
      metaKey: false,
      ctrlKey: true,
    });

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick.mock.calls[0][0]).toBe(DATA[0]);
    expect(onClick.mock.calls[0][1]).toEqual({
      shiftKey: true,
      metaKey: false,
      ctrlKey: true,
    });
  });
});

describe("VirtualRow memo contract: props the comparator ignores", () => {
  it("does not re-render when only onClick's identity changes", () => {
    const { rerenderHarness, renderCount } = renderHarness({ onClick: () => {} });
    expect(renderCount()).toBe(1);

    // A different function every time, which is what a parent that builds its
    // handler inline actually produces.
    for (let i = 0; i < 3; i += 1) {
      rerenderHarness({ onClick: () => {} });
    }

    expect(renderCount()).toBe(1);
  });

  it("does not re-render when only dataAttributes change", () => {
    const { rerenderHarness, renderCount } = renderHarness({
      dataAttributes: { searching: "false" },
    });
    expect(renderCount()).toBe(1);

    rerenderHarness({ dataAttributes: { searching: "true" } });

    expect(renderCount()).toBe(1);
  });
});

describe("VirtualRow memo contract: props the comparator watches", () => {
  // These are the negative controls. Without them "the count did not change"
  // would also be satisfied by a comparator that never re-renders anything,
  // or by a harness whose rerender does not actually reach the component.
  it("re-renders when isSelected changes", () => {
    const { container, rerenderHarness, renderCount } = renderHarness({
      isSelected: false,
    });

    rerenderHarness({ isSelected: true });

    expect(renderCount()).toBe(2);
    expect(container.querySelector("tr")!.getAttribute("data-state")).toBe(
      "selected"
    );
  });

  it("re-renders when isPrimarySelected changes", () => {
    const { rerenderHarness, renderCount } = renderHarness({
      isSelected: true,
      isPrimarySelected: false,
    });

    rerenderHarness({ isSelected: true, isPrimarySelected: true });

    expect(renderCount()).toBe(2);
  });

  it("re-renders when rowStateKey changes", () => {
    const { rerenderHarness, renderCount } = renderHarness({
      rowStateKey: "idle",
    });

    rerenderHarness({ rowStateKey: "searching" });

    expect(renderCount()).toBe(2);
  });

  it("re-renders and repositions when virtualStart changes", () => {
    const { container, rerenderHarness, renderCount } = renderHarness({
      virtualStart: 0,
    });
    expect(container.querySelector("tr")!.style.transform).toBe(
      "translateY(0px)"
    );

    rerenderHarness({ virtualStart: 120 });

    expect(renderCount()).toBe(2);
    expect(container.querySelector("tr")!.style.transform).toBe(
      "translateY(120px)"
    );
  });

  it("re-renders when a columnSizes value changes, but not when only its array identity does", () => {
    const { container, rerenderHarness, renderCount } = renderHarness({
      columnSizes: [200],
    });

    // Same widths, new array — the comparator compares element-wise, so this
    // must not re-render. A parent that rebuilds the array each render is the
    // common case.
    rerenderHarness({ columnSizes: [200] });
    expect(renderCount()).toBe(1);

    rerenderHarness({ columnSizes: [320] });
    expect(renderCount()).toBe(2);
    expect(container.querySelector("td")!.style.width).toBe("320px");
  });

  it("re-renders when className changes", () => {
    const { rerenderHarness, renderCount } = renderHarness({
      className: "bg-red-50",
    });

    rerenderHarness({ className: "bg-green-50" });

    expect(renderCount()).toBe(2);
  });
});
