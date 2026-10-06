import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ComponentDoc } from "@/lib/design-system/types";

function Basic() {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline">Hover me</Button>
        </TooltipTrigger>
        <TooltipContent>Short hint, one line</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

const doc: ComponentDoc = {
  title: "Tooltip",
  purpose: "A one-line hover hint, e.g. on an icon button; never the only place important text lives.",
  layer: "primitive",
  examples: [{ name: "Basic", Example: Basic }],
};
export default doc;
