import { Skeleton } from "@/components/ui/skeleton";
import type { ComponentDoc } from "@/lib/design-system/types";

function Row() {
  return (
    <div className="flex items-center gap-3 max-w-md">
      <Skeleton className="h-8 w-8 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}

const doc: ComponentDoc = {
  title: "Skeleton",
  purpose: "A grey placeholder in the shape of content that is still loading.",
  layer: "primitive",
  examples: [{ name: "Loading row", Example: Row }],
};
export default doc;
