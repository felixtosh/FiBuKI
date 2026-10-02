"use client";

import { useState } from "react";
import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * "done / total" with a progress ring, the same on the Files and the
 * Transactions list (#517). One ring, no inner arc. The explanation opens as
 * a popover when the counter is hovered (or tapped), and an info icon fades
 * in at the centre of the ring on hover, so the counter reads as something you
 * can ask about without taking any extra width.
 *
 * The explanation is passed in already translated: this primitive knows
 * nothing about what is being counted.
 */
export function ProgressCounter({
  done,
  total,
  explanation,
  bump = false,
  className,
}: {
  done: number;
  total: number;
  explanation: React.ReactNode;
  /** Plays the counter's bump animation, e.g. right after a row was resolved. */
  bump?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "group inline-flex items-center gap-1.5 rounded text-muted-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className
          )}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          <span className="relative inline-flex">
            <ProgressRing percent={percent} />
            <Info
              className="absolute inset-0 m-auto h-2.5 w-2.5 text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
              strokeWidth={3}
              aria-hidden="true"
            />
          </span>
          <span
            className={cn(
              "tabular-nums font-medium text-foreground inline-block",
              bump && "animate-counter-bump"
            )}
          >
            {done}
          </span>
          <span>/</span>
          <span className="tabular-nums">{total}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-72 text-xs leading-relaxed"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        {explanation}
      </PopoverContent>
    </Popover>
  );
}

function ProgressRing({ percent }: { percent: number }) {
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percent / 100) * circumference;
  const color =
    percent >= 100
      ? "text-yellow-500"
      : percent >= 67
        ? "text-green-500"
        : percent >= 33
          ? "text-amber-500"
          : "text-red-500";

  return (
    <svg width="20" height="20" viewBox="0 0 20 20" className="flex-shrink-0" aria-hidden="true">
      <circle cx="10" cy="10" r={radius} fill="none" stroke="currentColor" strokeWidth="2.5" className="text-muted-foreground/25" />
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 10 10)"
        className={cn(color, "transition-[stroke-dashoffset] duration-500 ease-out")}
      />
    </svg>
  );
}
