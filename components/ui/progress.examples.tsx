import { Progress } from "@/components/ui/progress";
import type { ComponentDoc } from "@/lib/design-system/types";

function Values() {
  return (
    <div className="space-y-3 max-w-sm">
      <Progress value={15} />
      <Progress value={60} />
      <Progress value={100} />
    </div>
  );
}

const doc: ComponentDoc = {
  title: "Progress",
  purpose: "A horizontal bar for a running task such as an import; list completeness uses ProgressCounter.",
  layer: "primitive",
  examples: [{ name: "Values", Example: Values }],
};
export default doc;
