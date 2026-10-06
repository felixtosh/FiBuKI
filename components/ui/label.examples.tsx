import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ComponentDoc } from "@/lib/design-system/types";

function WithInput() {
  return (
    <div className="space-y-2 max-w-sm">
      <Label htmlFor="ds-label-iban">IBAN</Label>
      <Input id="ds-label-iban" placeholder="AT.." />
    </div>
  );
}

const doc: ComponentDoc = {
  title: "Label",
  purpose: "The caption of a form control, linked to it with htmlFor.",
  layer: "primitive",
  examples: [{ name: "With an input", Example: WithInput }],
};
export default doc;
