"use client";

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { DocumentType } from "@/types/file";
import { describeDocumentType } from "@/lib/documents/document-type-presentation";
import type { DocumentTone } from "@/lib/documents/document-type-presentation";

/**
 * The § 11 document type as a badge (#205).
 *
 * Built here rather than inside the files table because the transaction
 * surfaces show the same fact about the same file, and two badges drifting
 * apart is how the same document ends up reading two ways.
 *
 * An absent `type` is not an empty cell. Until the backfill and the
 * re-extraction sweep run, most files carry no verdict at all, and that state
 * has to say "nicht bestimmt" rather than render as missing data.
 */

/** `unset` gets the quietest variant there is — it is a state, not a finding. */
const TONE_VARIANT: Record<DocumentTone, "success" | "warning" | "outline" | "muted"> = {
  positive: "success",
  warning: "warning",
  neutral: "outline",
  unset: "muted",
};

interface DocumentTypeBadgeProps {
  type: DocumentType | null | undefined;
  /** Suppress the tooltip where the surrounding row already explains itself. */
  withTooltip?: boolean;
  className?: string;
}

export function DocumentTypeBadge({
  type,
  withTooltip = true,
  className,
}: DocumentTypeBadgeProps) {
  const presentation = describeDocumentType(type);

  const badge = (
    <Badge
      variant={TONE_VARIANT[presentation.tone]}
      className={cn(
        "font-medium whitespace-nowrap",
        presentation.tone === "unset" && "text-muted-foreground",
        className
      )}
    >
      {presentation.label}
    </Badge>
  );

  if (!withTooltip) return badge;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{badge}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px]">
        <p className="text-xs">{presentation.summary}</p>
      </TooltipContent>
    </Tooltip>
  );
}
