"use client";

import { Info } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * The reasoning behind a field, one click away from its label.
 *
 * The file panel used to print its explanations inline: the § 11 verdict was a
 * heading, a summary sentence and a three-row basis table, and the direction
 * review was a bordered callout. Both sat above the two things a user actually
 * comes to this panel to do, which are assigning a Partner and connecting the
 * file to a Transaction. The reasoning is worth keeping and worth reading once;
 * it is not worth the top of the panel on every visit.
 *
 * So the label states the answer, and this holds the argument. "Type: Invoice"
 * is the whole of what most users need, and the § 11 test that produced it is
 * behind the icon for the visit where somebody disagrees with it.
 *
 * A button rather than a hover tooltip, deliberately: this content is a
 * paragraph and a definition list, it has to survive a touch device, and the
 * user needs to be able to read it without keeping a pointer still.
 */
interface InfoPopoverProps {
  /** Announced to screen readers, e.g. "Why this is an Invoice". */
  label: string;
  children: React.ReactNode;
  className?: string;
  align?: "start" | "center" | "end";
}

export function InfoPopover({
  label,
  children,
  className,
  align = "end",
}: InfoPopoverProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
            "text-muted-foreground/70 transition-colors hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className
          )}
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className="w-[320px] max-w-[calc(100vw-2rem)] space-y-3 text-left"
        // Stops a click inside the explanation from reaching a row that opens
        // something else. The panel's rows are clickable field targets.
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
