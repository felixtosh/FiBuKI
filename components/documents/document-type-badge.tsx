"use client";

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { DocumentType } from "@/types/file";
import type { DocumentationState } from "@/types/transaction";
import {
  describeDocumentType,
  describeDocumentationState,
} from "@/lib/documents/document-type-presentation";
import type { DocumentTone } from "@/lib/documents/document-type-presentation";

/**
 * The § 11 document type as a badge (#205), and how a transaction is
 * documented as the same badge (#207).
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

interface TonedBadgeProps {
  presentation: { label: string; tone: DocumentTone; summary: string };
  withTooltip: boolean;
  className?: string;
}

/**
 * One rendering for both badges: the tone table, the muted treatment of
 * `unset` and the summary tooltip are decided once, so a transaction's state
 * and its document's type cannot end up looking like different kinds of fact.
 */
function TonedBadge({ presentation, withTooltip, className }: TonedBadgeProps) {
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
  return (
    <TonedBadge
      presentation={describeDocumentType(type)}
      withTooltip={withTooltip}
      className={className}
    />
  );
}

interface DocumentationStateBadgeProps {
  state: DocumentationState | null | undefined;
  /** Suppress the tooltip where the surrounding row already explains itself. */
  withTooltip?: boolean;
  className?: string;
}

/**
 * How a transaction is documented (#207).
 *
 * A row documented by a payment confirmation and a row documented by a proper
 * Rechnung are both green — `isComplete` is untouched by design — so this
 * badge is the only thing that tells them apart, and a line resolved by a
 * no-receipt category has to be readable as neither.
 */
export function DocumentationStateBadge({
  state,
  withTooltip = true,
  className,
}: DocumentationStateBadgeProps) {
  return (
    <TonedBadge
      presentation={describeDocumentationState(state)}
      withTooltip={withTooltip}
      className={className}
    />
  );
}
