"use client";

import { FieldMapping } from "@/types/import";
import { TRANSACTION_FIELDS } from "@/lib/import/field-definitions";
import { parseDate } from "@/lib/import/date-parsers";
import {
  parseAmount,
  getAmountParserConfig,
  formatAmountForDisplay,
} from "@/lib/import/amount-parsers";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

interface ImportPreviewProps {
  rows: Record<string, string>[];
  mappings: FieldMapping[];
  totalRows: number;
}

export function ImportPreview({
  rows,
  mappings,
  totalRows,
}: ImportPreviewProps) {
  // Get mapped fields for display with their formats
  const mappedFields = mappings
    .filter((m) => m.targetField)
    .map((m) => ({
      csvColumn: m.csvColumn,
      targetField: m.targetField!,
      format: m.format,
      label:
        TRANSACTION_FIELDS.find((f) => f.key === m.targetField)?.label ||
        m.targetField!,
    }));

  // Transform rows for preview
  const previewRows = rows.slice(0, 50).map((row, index) => {
    const transformed: Record<string, { raw: string; parsed: string | number }> = {};

    for (const field of mappedFields) {
      const rawValue = row[field.csvColumn] || "";
      let parsedValue: string | number = rawValue;

      if (field.targetField === "date") {
        // No format means detection could not settle the column's day/month
        // order (#70). Rendering it through a default reads every row as
        // "Invalid" and hides why — say what the user has to do instead.
        if (!field.format) {
          parsedValue = "Select a date format";
        } else {
          const date = parseDate(rawValue, field.format);
          parsedValue = date ? format(date, "MMM d, yyyy") : "Invalid";
        }
      } else if (field.targetField === "amount") {
        const amountFormat = field.format || "de";
        const amountConfig = getAmountParserConfig(amountFormat);
        if (amountConfig) {
          const cents = parseAmount(rawValue, amountConfig);
          parsedValue = cents !== null ? formatAmountForDisplay(cents) : "Invalid";
        }
      }

      transformed[field.targetField] = { raw: rawValue, parsed: parsedValue };
    }

    return { index: index + 1, data: transformed };
  });

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0">
        <p className="text-sm text-muted-foreground">
          Showing {Math.min(50, rows.length)} of {totalRows} rows
        </p>
        <Badge variant="outline">
          {mappedFields.length} columns mapped
        </Badge>
      </div>

      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse min-w-[800px]">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr className="border-b">
              <th className="w-12 h-10 px-2 text-left text-sm font-medium text-muted-foreground pl-4">#</th>
              {mappedFields.map((field, index) => (
                <th
                  key={field.targetField}
                  className={cn(
                    "min-w-[150px] h-10 px-2 text-left text-sm font-medium",
                    index === mappedFields.length - 1 && "pr-4"
                  )}
                >
                  <div>
                    <span className="font-semibold">{field.label}</span>
                    <span className="block text-xs font-normal text-muted-foreground">
                      {field.csvColumn}
                    </span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {previewRows.map((row) => (
              <tr key={row.index} className="border-b">
                <td className="text-muted-foreground px-2 py-2.5 pl-4">
                  {row.index}
                </td>
                {mappedFields.map((field, index) => {
                  const cell = row.data[field.targetField];
                  const isInvalid =
                    cell?.parsed === "Invalid" ||
                    (field.targetField === "amount" &&
                      typeof cell?.parsed === "string" &&
                      cell.parsed.includes("Invalid"));

                  return (
                    <td
                      key={field.targetField}
                      className={cn(
                        "px-2 py-2.5",
                        index === mappedFields.length - 1 && "pr-4",
                        isInvalid && "text-destructive bg-destructive/10"
                      )}
                    >
                      <div>
                        <span className="font-medium">
                          {cell?.parsed ?? "-"}
                        </span>
                        {cell?.raw !== cell?.parsed && (
                          <span className="block text-xs text-muted-foreground">
                            {cell?.raw}
                          </span>
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length > 50 && (
        <p className="text-sm text-muted-foreground text-center py-3 border-t flex-shrink-0">
          ...and {totalRows - 50} more rows will be imported
        </p>
      )}
    </div>
  );
}
