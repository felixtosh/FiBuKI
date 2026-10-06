"use client";

import { useState } from "react";
import { Calendar } from "@/components/ui/calendar";
import type { ComponentDoc } from "@/lib/design-system/types";

function Single() {
  const [day, setDay] = useState<Date | undefined>(new Date("2026-03-15T00:00:00Z"));
  return (
    <Calendar
      mode="single"
      selected={day}
      onSelect={setDay}
      defaultMonth={new Date("2026-03-01T00:00:00Z")}
      className="rounded-md border w-fit"
    />
  );
}

const doc: ComponentDoc = {
  title: "Calendar",
  purpose: "A month grid to pick a day; a list's date filter is DateRangeFilter.",
  layer: "primitive",
  examples: [{ name: "Single day", Example: Single }],
};
export default doc;
