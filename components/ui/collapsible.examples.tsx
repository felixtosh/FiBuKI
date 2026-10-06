"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ComponentDoc } from "@/lib/design-system/types";

function Basic() {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="max-w-sm">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2">
          <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
          Advanced
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="text-sm text-muted-foreground px-3 py-2">
        Hidden until opened.
      </CollapsibleContent>
    </Collapsible>
  );
}

const doc: ComponentDoc = {
  title: "Collapsible",
  purpose: "Show and hide a block in place; a detail panel list section uses CollapsibleListSection.",
  layer: "primitive",
  examples: [{ name: "Basic", Example: Basic }],
};
export default doc;
