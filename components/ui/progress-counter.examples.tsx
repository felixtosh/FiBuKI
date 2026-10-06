import { ProgressCounter } from "@/components/ui/progress-counter";
import type { ComponentDoc } from "@/lib/design-system/types";

function Levels() {
  return (
    <div className="flex flex-wrap items-center gap-6">
      {[
        [3, 40],
        [18, 40],
        [31, 40],
        [40, 40],
      ].map(([done, total]) => (
        <ProgressCounter key={done} done={done} total={total} explanation="Transactions with a receipt, or marked as not needing one." />
      ))}
    </div>
  );
}

const doc: ComponentDoc = {
  title: "ProgressCounter",
  purpose: "A list page's done / total counter with a ring and an explanation on hover.",
  layer: "pattern",
  examples: [{ name: "Levels", Example: Levels }],
};
export default doc;
