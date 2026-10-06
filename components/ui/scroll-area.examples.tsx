import { ScrollArea } from "@/components/ui/scroll-area";
import type { ComponentDoc } from "@/lib/design-system/types";

function Basic() {
  return (
    <ScrollArea className="h-32 w-64 rounded-md border">
      <div className="p-3 space-y-2 text-sm">
        {Array.from({ length: 12 }, (_, i) => (
          <p key={i}>Receipt {i + 1}</p>
        ))}
      </div>
    </ScrollArea>
  );
}

const doc: ComponentDoc = {
  title: "ScrollArea",
  purpose: "A scroll container with a styled scrollbar for a fixed-height region.",
  layer: "primitive",
  examples: [{ name: "Basic", Example: Basic }],
};
export default doc;
