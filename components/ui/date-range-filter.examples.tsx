"use client";

import { useState } from "react";
import { DateRangeFilter } from "@/components/ui/date-range-filter";
import type { ComponentDoc } from "@/lib/design-system/types";

function Basic() {
  const [range, setRange] = useState<{ from?: Date; to?: Date }>({
    from: new Date("2026-01-01T00:00:00Z"),
    to: new Date("2026-03-31T00:00:00Z"),
  });
  return <DateRangeFilter from={range.from} to={range.to} onChange={(from, to) => setRange({ from, to })} />;
}

const doc: ComponentDoc = {
  title: "DateRangeFilter",
  purpose: "The Date chip of a list toolbar: presets plus a From/To pair.",
  layer: "pattern",
  examples: [{ name: "Set", Example: Basic }],
};
export default doc;
