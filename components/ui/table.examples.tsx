import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ComponentDoc } from "@/lib/design-system/types";

const rows = [
  { id: "1", date: "15.03.2026", name: "A1 Telekom", amount: "-€49,90" },
  { id: "2", date: "12.03.2026", name: "Kunde GmbH", amount: "€1.200,00" },
];

function Static() {
  return (
    <Table className="max-w-lg">
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Counterparty</TableHead>
          <TableHead className="text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell>{row.date}</TableCell>
            <TableCell>{row.name}</TableCell>
            <TableCell className="text-right tabular-nums">{row.amount}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const doc: ComponentDoc = {
  title: "Table",
  purpose: "A small static table; a full list page uses ResizableDataTable instead.",
  layer: "primitive",
  examples: [{ name: "Static", Example: Static }],
};
export default doc;
