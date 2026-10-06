"use client";

import { useState } from "react";
import { ShowMoreButton } from "@/components/ui/show-more-button";
import type { ComponentDoc } from "@/lib/design-system/types";

function Basic() {
  const [expanded, setExpanded] = useState(false);
  return <ShowMoreButton expanded={expanded} onToggle={() => setExpanded((e) => !e)} />;
}

const doc: ComponentDoc = {
  title: "ShowMoreButton",
  purpose: "Expands a list or text that is cut short.",
  layer: "pattern",
  examples: [{ name: "Basic", Example: Basic }],
};
export default doc;
