import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ComponentDoc } from "@/lib/design-system/types";

function Basic() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">Open popover</Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 text-sm" align="start">
        Anchored floating content. Filters, pickers and explanations open in one.
      </PopoverContent>
    </Popover>
  );
}

const doc: ComponentDoc = {
  title: "Popover",
  purpose: "Floating content anchored to a trigger; for a short hover hint use Tooltip, for an explanation use InfoPopover.",
  layer: "primitive",
  examples: [{ name: "Basic", Example: Basic }],
};
export default doc;
