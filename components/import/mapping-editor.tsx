"use client";

import { FieldMapping, FieldDefinition } from "@/types/import";
import { MappingRow } from "./mapping-row";
import { TRANSACTION_FIELDS } from "@/lib/import/field-definitions";
import { validateMappings } from "@/lib/import/field-matcher";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertCircle } from "lucide-react";

interface MappingEditorProps {
  mappings: FieldMapping[];
  sampleRows: Record<string, string>[];
  onMappingChange: (index: number, targetField: string | null) => void;
  onFormatChange: (index: number, format: string) => void;
  onMappingDelete?: (index: number) => void;
  /** Custom field definitions (defaults to TRANSACTION_FIELDS) */
  fieldDefinitions?: FieldDefinition[];
}

export function MappingEditor({
  mappings,
  sampleRows,
  onMappingChange,
  onFormatChange,
  onMappingDelete,
  fieldDefinitions,
}: MappingEditorProps) {
  const fields = fieldDefinitions || TRANSACTION_FIELDS;

  // Get list of already mapped fields
  const mappedFields = new Set(
    mappings.filter((m) => m.targetField).map((m) => m.targetField)
  );

  // Check for missing required fields using centralized validation
  const validation = validateMappings(mappings);
  const missingRequired = validation.missingFields;

  return (
    <div className="space-y-6">
      {/* Missing required fields warning */}
      {missingRequired.length > 0 && (
        <div className="flex items-start gap-3 p-4 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-lg">
          <AlertCircle className="h-5 w-5 text-destructive mt-0.5" />
          <div>
            <p className="font-medium text-destructive">
              Missing required fields
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              Please map the following fields:{" "}
              {missingRequired.join(", ")}
            </p>
          </div>
        </div>
      )}

      {/* Column mappings */}
      <Card className="flex flex-col overflow-hidden" style={{ maxHeight: "calc(100vh - 400px)", minHeight: "300px" }}>
        <CardHeader className="pb-3 flex-shrink-0">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Column Mappings</CardTitle>
            <Badge variant="outline">
              {mappings.filter((m) => m.targetField).length} of{" "}
              {mappings.length} mapped
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Match your CSV columns to transaction fields. Green = matched. Only Date, Amount, and Description or Partner are required.
          </p>
        </CardHeader>
        <CardContent className="flex-1 overflow-auto">
          <div className="space-y-2">
            {mappings.map((mapping, index) => {
              // Get sample values for this column
              const samples = sampleRows
                .slice(0, 5)
                .map((row) => row[mapping.csvColumn])
                .filter((v) => v && v.trim().length > 0);

              return (
                <MappingRow
                  key={mapping.csvColumn}
                  mapping={mapping}
                  samples={samples}
                  usedFields={mappedFields}
                  onChange={(targetField) => onMappingChange(index, targetField)}
                  onFormatChange={(format) => onFormatChange(index, format)}
                  onDelete={onMappingDelete ? () => onMappingDelete(index) : undefined}
                  fieldDefinitions={fieldDefinitions}
                />
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
