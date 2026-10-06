"use client";

import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { ResizableDataTable, SortableHeader } from "@/components/ui/data-table";
import type { ComponentDoc } from "@/lib/design-system/types";

interface Row {
  id: string;
  date: string;
  name: string;
  amount: number;
}

const data: Row[] = [
  { id: "1", date: "2026-03-15", name: "A1 Telekom", amount: -4990 },
  { id: "2", date: "2026-03-12", name: "Kunde GmbH", amount: 120000 },
  { id: "3", date: "2026-03-10", name: "Amazon EU", amount: -2399 },
  { id: "4", date: "2026-03-03", name: "Wiener Linien", amount: -36500 },
  { id: "5", date: "2026-03-01", name: "SVS", amount: -82015 },
];

const euro = new Intl.NumberFormat("de-AT", { style: "currency", currency: "EUR" });

const columns: ColumnDef<Row, unknown>[] = [
  {
    accessorKey: "date",
    header: ({ column }) => <SortableHeader column={column}>Date</SortableHeader>,
    cell: ({ row }) => row.original.date.split("-").reverse().join("."),
  },
  {
    accessorKey: "name",
    header: ({ column }) => <SortableHeader column={column}>Partner</SortableHeader>,
  },
  {
    accessorKey: "amount",
    header: ({ column }) => <SortableHeader column={column}>Amount</SortableHeader>,
    cell: ({ row }) => (
      <span className={row.original.amount < 0 ? "tabular-nums text-amount-negative" : "tabular-nums text-amount-positive"}>
        {euro.format(row.original.amount / 100)}
      </span>
    ),
  },
];

function Basic() {
  const [selected, setSelected] = useState<string | null>("2");
  return (
    <div className="h-72 border rounded-md overflow-hidden">
      <ResizableDataTable
        columns={columns}
        data={data}
        selectedRowId={selected}
        onRowClick={(row) => setSelected(row.id)}
        defaultColumnSizes={{ date: 120, name: 240, amount: 140 }}
        // On the real pages the selected row scrolls into view; here that would
        // scroll the whole design-system page down to this example on load.
        autoScrollToSelected={false}
      />
    </div>
  );
}

const doc: ComponentDoc = {
  title: "ResizableDataTable",
  purpose: "The virtualised, sortable, resizable table of every list page (Files, Transactions, Partners).",
  layer: "pattern",
  examples: [{ name: "Sort, resize, select", Example: Basic }],
};
export default doc;
