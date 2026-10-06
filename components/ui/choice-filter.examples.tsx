"use client";

import { useState } from "react";
import { FileText } from "lucide-react";
import { ChoiceFilter } from "@/components/ui/choice-filter";
import type { ComponentDoc } from "@/lib/design-system/types";

type Kind = "invoice" | "receipt" | "other" | "none";

const options = [
  { value: "invoice" as const, label: "Invoice" },
  { value: "receipt" as const, label: "Receipt" },
  { value: "other" as const, label: "Other" },
  { value: "none" as const, label: "Not determined", separated: true },
];

function Basic() {
  const [empty, setEmpty] = useState<Kind | undefined>(undefined);
  const [picked, setPicked] = useState<Kind | undefined>("receipt");
  return (
    <div className="flex flex-wrap gap-2">
      <ChoiceFilter label="Type" icon={<FileText className="h-4 w-4" />} allLabel="All types" options={options} value={empty} onChange={setEmpty} />
      <ChoiceFilter label="Type" icon={<FileText className="h-4 w-4" />} allLabel="All types" options={options} value={picked} onChange={setPicked} />
    </div>
  );
}

const doc: ComponentDoc = {
  title: "ChoiceFilter",
  purpose: "A list toolbar chip that filters one column to one value or none.",
  layer: "pattern",
  examples: [{ name: "Unset and set", Example: Basic }],
};
export default doc;
