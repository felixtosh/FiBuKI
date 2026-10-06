"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DetailPanelLayout } from "@/components/ui/detail-panel-layout";
import { SampleDetailPanel } from "@/components/ui/detail-panel-primitives.examples";
import type { ComponentDoc } from "@/lib/design-system/types";

function OpenClose() {
  const [open, setOpen] = useState(false);
  return (
    <DetailPanelLayout
      storageKey="fibuki.designSystem.panelWidth"
      defaultWidth={420}
      minWidth={320}
      maxWidth={640}
      open={open}
      panel={<SampleDetailPanel onClose={() => setOpen(false)} />}
      mainClassName=""
    >
      <div className="rounded-md border p-4 space-y-3 text-sm">
        <p className="text-muted-foreground">
          The list side. Opening the panel slides it in from the right edge of the window and makes room for it; drag its left edge to resize.
        </p>
        <Button variant="outline" onClick={() => setOpen((o) => !o)}>{open ? "Close panel" : "Open panel"}</Button>
      </div>
    </DetailPanelLayout>
  );
}

const doc: ComponentDoc = {
  title: "DetailPanelLayout",
  purpose: "A list page's frame: the list on the left and a resizable detail panel docked on the right.",
  layer: "pattern",
  examples: [{ name: "Open and close", Example: OpenClose }],
};
export default doc;
