"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ContentOverlay } from "@/components/ui/content-overlay";
import type { ComponentDoc } from "@/lib/design-system/types";

function InContainer() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative h-72 rounded-md border overflow-hidden">
      <div className="p-4 text-sm text-muted-foreground">The list behind the overlay.</div>
      <div className="px-4">
        <Button variant="outline" onClick={() => setOpen(true)}>Open overlay</Button>
      </div>
      <ContentOverlay open={open} onClose={() => setOpen(false)} title="Connect file" subtitle="A1 Telekom, -€49,90">
        <div className="p-4 text-sm">Search and results go here.</div>
      </ContentOverlay>
    </div>
  );
}

const doc: ComponentDoc = {
  title: "ContentOverlay",
  purpose: "A large overlay over the list area (not the whole screen), e.g. the connect flow.",
  layer: "pattern",
  examples: [{ name: "Inside a container", Example: InContainer }],
};
export default doc;
