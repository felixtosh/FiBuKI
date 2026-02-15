"use client";

import { RemapPreview, RemapPreviewRow } from "@/types/import";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileText,
  Link2,
  User,
} from "lucide-react";

interface RemapPreviewComponentProps {
  preview: RemapPreview;
}

export function RemapPreviewComponent({ preview }: RemapPreviewComponentProps) {
  const rowsWithChanges = preview.matchedRows.filter((r) => r.changes.length > 0);
  const rowsWithoutChanges = preview.matchedRows.filter((r) => r.changes.length === 0);

  return (
    <div className="flex-1 overflow-auto px-4 py-6 space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6 text-center">
            <p className="text-3xl font-bold text-primary">{preview.totalChanges}</p>
            <p className="text-sm text-muted-foreground">Total Changes</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 text-center">
            <p className="text-3xl font-bold">{rowsWithChanges.length}</p>
            <p className="text-sm text-muted-foreground">Rows Affected</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 text-center">
            <p className="text-3xl font-bold text-muted-foreground">
              {rowsWithoutChanges.length}
            </p>
            <p className="text-sm text-muted-foreground">Unchanged</p>
          </CardContent>
        </Card>
      </div>

      {/* Warnings */}
      {preview.warnings.length > 0 && (
        <Card className="border-yellow-200 dark:border-yellow-900 bg-yellow-50 dark:bg-yellow-950/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2 text-yellow-600 dark:text-yellow-400">
              <AlertTriangle className="h-4 w-4" />
              Warnings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="text-sm text-muted-foreground space-y-1">
              {preview.warnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* No changes message */}
      {preview.totalChanges === 0 && (
        <Card>
          <CardContent className="pt-6 text-center">
            <CheckCircle2 className="h-12 w-12 text-green-600 dark:text-green-400 mx-auto mb-4" />
            <p className="font-medium">No changes detected</p>
            <p className="text-sm text-muted-foreground mt-1">
              The current mapping produces the same results as before.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Changes Table */}
      {rowsWithChanges.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Changes to Apply</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-[400px] overflow-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-background">
                  <TableRow>
                    <TableHead className="w-20">Row</TableHead>
                    <TableHead>Field</TableHead>
                    <TableHead>Current Value</TableHead>
                    <TableHead className="w-10"></TableHead>
                    <TableHead>New Value</TableHead>
                    <TableHead>Preserved</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rowsWithChanges.slice(0, 100).map((row) => (
                    <RowChanges key={row.csvRowIndex} row={row} />
                  ))}
                </TableBody>
              </Table>
              {rowsWithChanges.length > 100 && (
                <div className="p-4 text-center text-sm text-muted-foreground border-t">
                  Showing first 100 of {rowsWithChanges.length} rows with changes
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Preserved Data Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
            Data That Will Be Preserved
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            The following user-provided data will be kept when applying the new mapping:
          </p>
          <div className="flex flex-wrap gap-2">
            <PreservedBadge icon={<User className="h-3 w-3" />} label="Partner matches" />
            <PreservedBadge icon={<FileText className="h-3 w-3" />} label="Attached files" />
            <PreservedBadge icon={<Link2 className="h-3 w-3" />} label="Descriptions" />
            <PreservedBadge label="No-receipt categories" />
            <PreservedBadge label="Completion status" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function RowChanges({ row }: { row: RemapPreviewRow }) {
  return (
    <>
      {row.changes.map((change, i) => (
        <TableRow key={`${row.csvRowIndex}-${change.field}`}>
          {i === 0 && (
            <TableCell rowSpan={row.changes.length} className="font-mono text-sm">
              {row.csvRowIndex + 1}
            </TableCell>
          )}
          <TableCell className="font-medium">{change.field}</TableCell>
          <TableCell className="text-muted-foreground">
            {formatValue(change.oldValue)}
          </TableCell>
          <TableCell>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
          </TableCell>
          <TableCell className="text-primary font-medium">
            {formatValue(change.newValue)}
          </TableCell>
          {i === 0 && (
            <TableCell rowSpan={row.changes.length}>
              {row.preservedFields.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {row.preservedFields.slice(0, 3).map((field) => (
                    <Badge key={field} variant="secondary" className="text-xs">
                      {formatFieldName(field)}
                    </Badge>
                  ))}
                  {row.preservedFields.length > 3 && (
                    <Badge variant="secondary" className="text-xs">
                      +{row.preservedFields.length - 3}
                    </Badge>
                  )}
                </div>
              )}
            </TableCell>
          )}
        </TableRow>
      ))}
    </>
  );
}

function PreservedBadge({
  icon,
  label,
}: {
  icon?: React.ReactNode;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-green-50 dark:bg-green-950/30 text-green-600 dark:text-green-400 border border-green-200 dark:border-green-900 rounded-full text-sm">
      {icon}
      {label}
    </div>
  );
}

function formatValue(value: string | number | null): string {
  if (value === null || value === undefined) {
    return "-";
  }
  if (typeof value === "number") {
    // Format as currency if it looks like cents
    if (Math.abs(value) > 100) {
      return new Intl.NumberFormat("de-DE", {
        style: "currency",
        currency: "EUR",
      }).format(value / 100);
    }
    return value.toString();
  }
  return value;
}

function formatFieldName(field: string): string {
  const names: Record<string, string> = {
    partnerId: "Partner",
    fileIds: "Files",
    description: "Note",
    noReceiptCategoryId: "Category",
    isComplete: "Complete",
  };
  return names[field] || field;
}
