"use client";

import { useState } from "react";
import { format } from "date-fns";
import { CalendarDays, CalendarIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * The Date chip on the Files and the Transactions toolbar: a From/To pair and
 * quick presets. It owns its popover state (#528), so the same chip can sit in
 * the toolbar row and in the "More" panel at once without one opening the
 * other.
 */
export function DateRangeFilter({
  from,
  to,
  onChange,
}: {
  from: Date | undefined;
  to: Date | undefined;
  onChange: (from: Date | undefined, to: Date | undefined) => void;
}) {
  const [datePopoverOpen, setDatePopoverOpen] = useState(false);
  const [showFromCalendar, setShowFromCalendar] = useState(false);
  const [showToCalendar, setShowToCalendar] = useState(false);
  const hasDateFilter = Boolean(from || to);

  const handleDatePresetClick = (preset: string) => {
    const now = new Date();
    switch (preset) {
      case "30d":
        onChange(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), now);
        break;
      case "3m":
        onChange(new Date(now.getFullYear(), now.getMonth() - 3, now.getDate()), now);
        break;
      case "thisYear":
        onChange(new Date(now.getFullYear(), 0, 1), now);
        break;
      case "lastYear":
        onChange(new Date(now.getFullYear() - 1, 0, 1), new Date(now.getFullYear() - 1, 11, 31));
        break;
      default:
        onChange(undefined, undefined);
    }
    setDatePopoverOpen(false);
  };

  const clearDateFilter = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    onChange(undefined, undefined);
  };

  const getDateLabel = () => {
    if (from && to) return `${format(from, "MMM d")} - ${format(to, "MMM d")}`;
    if (from) return `From ${format(from, "MMM d")}`;
    if (to) return `Until ${format(to, "MMM d")}`;
    return "Date";
  };

  return (
    <Popover open={datePopoverOpen} onOpenChange={setDatePopoverOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={hasDateFilter ? "secondary" : "outline"}
          size="sm"
          className="h-9 gap-2"
        >
          <CalendarDays className="h-4 w-4" />
          <span>{getDateLabel()}</span>
          {hasDateFilter && (
            <span
              role="button"
              tabIndex={0}
              onClick={clearDateFilter}
              onKeyDown={(e) => e.key === "Enter" && clearDateFilter(e)}
              className="ml-1 hover:bg-muted rounded p-0.5 -mr-1 cursor-pointer"
            >
              <X className="h-3 w-3" />
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-4" align="start">
        <div className="space-y-4">
          {/* From/To date pickers on top */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">From</label>
              <Popover open={showFromCalendar} onOpenChange={setShowFromCalendar}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-full justify-start text-left font-normal h-9",
                      !from && "text-muted-foreground"
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {from ? format(from, "PP") : "Pick date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={from}
                    onSelect={(date) => {
                      onChange(date, to);
                      setShowFromCalendar(false);
                    }}
                    autoFocus
                  />
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">To</label>
              <Popover open={showToCalendar} onOpenChange={setShowToCalendar}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-full justify-start text-left font-normal h-9",
                      !to && "text-muted-foreground"
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {to ? format(to, "PP") : "Pick date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={to}
                    onSelect={(date) => {
                      onChange(from, date);
                      setShowToCalendar(false);
                    }}
                    autoFocus
                  />
                </PopoverContent>
              </Popover>
            </div>
          </div>

          {/* Separator */}
          <div className="border-t" />

          {/* Quick presets as buttons */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Quick select</label>
            <div className="flex flex-wrap gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => handleDatePresetClick("all")}
              >
                All time
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => handleDatePresetClick("30d")}
              >
                30 days
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => handleDatePresetClick("3m")}
              >
                3 months
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => handleDatePresetClick("thisYear")}
              >
                This year
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => handleDatePresetClick("lastYear")}
              >
                Last year
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
