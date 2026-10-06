"use client";

import { useState } from "react";
import { SearchInput } from "@/components/ui/search-input";
import type { ComponentDoc } from "@/lib/design-system/types";

function Basic() {
  const [value, setValue] = useState("telekom");
  return (
    <div className="max-w-sm">
      <SearchInput value={value} onChange={setValue} placeholder="Search partners..." />
    </div>
  );
}

const doc: ComponentDoc = {
  title: "SearchInput",
  purpose: "An always-visible search field with a clear button, e.g. inside a picker; a list toolbar uses SearchButton.",
  layer: "pattern",
  examples: [{ name: "Basic", Example: Basic }],
};
export default doc;
