"use client";

import { FieldMapping, FieldDefinition } from "@/types/import";
import { TRANSACTION_FIELDS } from "@/lib/import/field-definitions";
import { DATE_PARSERS } from "@/lib/import/date-parsers";
import { AMOUNT_PARSERS } from "@/lib/import/amount-parsers";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ArrowRight, Trash2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

interface MappingRowProps {
  mapping: FieldMapping;
  samples: string[];
  usedFields: Set<string | null>;
  onChange: (targetField: string | null, format?: string) => void;
  onFormatChange: (format: string) => void;
  onDelete?: () => void;
  /** Custom field definitions (defaults to TRANSACTION_FIELDS) */
  fieldDefinitions?: FieldDefinition[];
}

export function MappingRow({
  mapping,
  samples,
  usedFields,
  onChange,
  onFormatChange,
  onDelete,
  fieldDefinitions,
}: MappingRowProps) {
  const fields = fieldDefinitions || TRANSACTION_FIELDS;
  const isAutoMatched = mapping.confidence > 0.7 && !mapping.userConfirmed;
  const fieldDef = fields.find((f) => f.key === mapping.targetField);
  const needsFormat = fieldDef?.type === "date" || fieldDef?.type === "amount";
  const formatOptions = fieldDef?.type === "date" ? DATE_PARSERS : AMOUNT_PARSERS;

  return (
    <div
      className={cn(
        "flex items-center gap-3 p-3 rounded-lg border transition-colors",
        mapping.targetField
          ? "bg-green-50 border-green-200 dark:bg-green-950/20 dark:border-green-900"
          : "bg-muted/50 border-border"
      )}
    >
      {/* CSV Column */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-medium truncate">{mapping.csvColumn}</p>
          {isAutoMatched && (
            <div className="flex items-center gap-1">
              <Sparkles className="h-3 w-3 text-primary" />
              <span className="text-xs text-muted-foreground">
                {Math.round(mapping.confidence * 100)}%
              </span>
            </div>
          )}
        </div>
        {samples.length > 0 && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {samples.join(" · ")}
          </p>
        )}
      </div>

      {/* Arrow */}
      <ArrowRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />

      {/* Target Field Selector */}
      <div className="w-44 flex-shrink-0">
        <Select
          value={mapping.targetField || "_unmapped"}
          onValueChange={(value) =>
            onChange(value === "_unmapped" ? null : value)
          }
        >
          <SelectTrigger className="h-9">
            <SelectValue placeholder="Select field" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_unmapped">
              <span className="text-muted-foreground">Keep as metadata</span>
            </SelectItem>
            {fields.map((field) => {
              const isUsed =
                usedFields.has(field.key) && mapping.targetField !== field.key;
              return (
                <SelectItem
                  key={field.key}
                  value={field.key}
                  disabled={isUsed}
                >
                  <span className="whitespace-nowrap">
                    {field.label}
                    {field.required && " *"}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>

      {/* Format Selector (for date/amount fields) */}
      {needsFormat && (
        <div className="w-52 flex-shrink-0">
          <Select
            value={mapping.format || ""}
            onValueChange={onFormatChange}
          >
            <SelectTrigger className="h-9">
              <SelectValue placeholder="Select format" />
            </SelectTrigger>
            <SelectContent>
              {formatOptions.map((parser) => (
                <SelectItem key={parser.id} value={parser.id}>
                  <span className="whitespace-nowrap">{parser.name}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Delete button */}
      {onDelete && (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          title="Exclude from import"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
