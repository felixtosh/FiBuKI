"use client";

import { useState } from "react";
import { Building2, Tag } from "lucide-react";
import { Pill } from "@/components/ui/pill";
import type { ComponentDoc } from "@/lib/design-system/types";

function Assigned() {
  const [shown, setShown] = useState(true);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Pill label="A1 Telekom" icon={Building2} matchedBy="manual" />
      <Pill label="Software" icon={Tag} matchedBy="auto" confidence={92} />
      {shown && <Pill label="Removable" icon={Tag} onRemove={() => setShown(false)} />}
      <Pill label="Disabled" disabled />
    </div>
  );
}

function Suggestion() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Pill label="Amazon EU" icon={Building2} variant="suggestion" confidence={87} onClick={() => {}} />
      <Pill label="Office" icon={Tag} variant="suggestion" confidence={64} onClick={() => {}} />
    </div>
  );
}

const doc: ComponentDoc = {
  title: "Pill",
  purpose: "An assigned or suggested Partner or Category in a cell or panel, clickable and removable; a static label is a Badge.",
  layer: "pattern",
  examples: [
    { name: "Assigned", Example: Assigned },
    { name: "Suggestion", Example: Suggestion },
  ],
};
export default doc;
