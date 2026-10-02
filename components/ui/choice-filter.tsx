"use client";

import { Fragment, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface ChoiceFilterOption<V extends string> {
  value: V;
  label: string;
  icon?: React.ReactNode;
  /** Draws a line above this option, to set it apart from the ones before. */
  separated?: boolean;
}

/**
 * A toolbar chip that picks one value or none (#519). The chip shows the
 * column's name until something is picked, then the picked value and a clear
 * button. Labels arrive translated; this primitive knows nothing about what it
 * filters.
 */
export function ChoiceFilter<V extends string>({
  label,
  icon,
  allLabel,
  options,
  value,
  onChange,
}: {
  label: string;
  icon?: React.ReactNode;
  /** The "no filter" row at the top of the list. */
  allLabel: string;
  options: ChoiceFilterOption<V>[];
  value: V | undefined;
  onChange: (value: V | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const picked = options.find((option) => option.value === value);

  const pick = (next: V | undefined) => {
    onChange(next);
    setOpen(false);
  };
  const clear = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    onChange(undefined);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant={picked ? "secondary" : "outline"} size="sm" className="h-9 gap-2">
          {icon}
          <span>{picked ? picked.label : label}</span>
          {picked && (
            <span
              role="button"
              tabIndex={0}
              aria-label={allLabel}
              onClick={clear}
              onKeyDown={(e) => e.key === "Enter" && clear(e)}
              className="ml-1 hover:bg-muted rounded p-0.5 -mr-1 cursor-pointer"
            >
              <X className="h-3 w-3" />
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto min-w-[10rem] p-2" align="start">
        <div className="flex flex-col gap-1">
          <Button
            variant={picked ? "ghost" : "secondary"}
            size="sm"
            className="justify-start h-8"
            onClick={() => pick(undefined)}
          >
            {allLabel}
          </Button>
          {options.map((option) => (
            <Fragment key={option.value}>
              {option.separated && <div className="border-t my-1" />}
              <Button
                variant={option.value === value ? "secondary" : "ghost"}
                size="sm"
                className="justify-start h-8 gap-2"
                onClick={() => pick(option.value)}
              >
                {option.icon}
                {option.label}
              </Button>
            </Fragment>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
