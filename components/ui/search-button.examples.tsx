"use client";

import { useState } from "react";
import { SearchButton } from "@/components/ui/search-button";
import type { ComponentDoc } from "@/lib/design-system/types";

function Basic() {
  const [value, setValue] = useState("");
  return <SearchButton value={value} onSearch={setValue} placeholder="Search transactions..." />;
}

const doc: ComponentDoc = {
  title: "SearchButton",
  purpose: "The search control that leads a list toolbar.",
  layer: "pattern",
  examples: [{ name: "Basic", Example: Basic }],
};
export default doc;
