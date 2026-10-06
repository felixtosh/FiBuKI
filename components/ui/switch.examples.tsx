"use client";

import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { ComponentDoc } from "@/lib/design-system/types";

function Setting() {
  const [on, setOn] = useState(true);
  return (
    <div className="flex items-center gap-3">
      <Switch id="ds-switch" checked={on} onCheckedChange={setOn} />
      <Label htmlFor="ds-switch">Match receipts automatically</Label>
    </div>
  );
}

const doc: ComponentDoc = {
  title: "Switch",
  purpose: "A setting that takes effect the moment it is flipped.",
  layer: "primitive",
  examples: [{ name: "Setting", Example: Setting }],
};
export default doc;
