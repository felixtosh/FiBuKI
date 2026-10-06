"use client";

import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { ComponentDoc } from "@/lib/design-system/types";

function States() {
  const [checked, setChecked] = useState(true);
  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="flex items-center gap-2">
        <Checkbox id="ds-cb-1" checked={checked} onCheckedChange={(v) => setChecked(v === true)} />
        <Label htmlFor="ds-cb-1">Checked</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="ds-cb-2" />
        <Label htmlFor="ds-cb-2">Unchecked</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="ds-cb-3" checked="indeterminate" />
        <Label htmlFor="ds-cb-3">Some selected</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="ds-cb-4" disabled />
        <Label htmlFor="ds-cb-4">Disabled</Label>
      </div>
    </div>
  );
}

const doc: ComponentDoc = {
  title: "Checkbox",
  purpose: "A yes/no choice in a form or a row selection box; for a setting that applies at once use Switch.",
  layer: "primitive",
  examples: [{ name: "States", Example: States }],
};
export default doc;
