"use client";

import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { describeTerm } from "@/lib/documents/document-type-presentation";
import type { TermGlossKey } from "@/lib/documents/document-type-presentation";

/**
 * The hover "i" beside a statutory term (#237).
 *
 * Vocabulary only, never a finding: hover is unreachable on touch, so nothing
 * a user needs in order to act may live only in here. The wording comes from
 * `TERM_GLOSSES`, the one place each term is defined, so the same term cannot
 * read two ways on two screens. Radix opens the tooltip on keyboard focus as
 * well as on hover.
 */
export function TermGloss({ term, className }: { term: TermGlossKey; className?: string }) {
  const gloss = describeTerm(term);
  if (!gloss) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`What "${gloss.term}" means`}
          className={cn(
            "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full align-middle",
            "text-muted-foreground/70 transition-colors hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className
          )}
        >
          <Info className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[280px]">
        <p className="text-xs">
          <span className="font-medium">
            {gloss.term}
            {gloss.german ? ` (${gloss.german})` : ""}
          </span>
          {": "}
          {gloss.text}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
