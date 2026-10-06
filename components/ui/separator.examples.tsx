import { Separator } from "@/components/ui/separator";
import type { ComponentDoc } from "@/lib/design-system/types";

function Orientations() {
  return (
    <div className="max-w-sm text-sm">
      <p>Above</p>
      <Separator className="my-3" />
      <div className="flex h-5 items-center gap-3">
        <span>Left</span>
        <Separator orientation="vertical" />
        <span>Right</span>
      </div>
    </div>
  );
}

const doc: ComponentDoc = {
  title: "Separator",
  purpose: "A thin horizontal or vertical divider line.",
  layer: "primitive",
  examples: [{ name: "Orientations", Example: Orientations }],
};
export default doc;
