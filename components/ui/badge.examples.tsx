import { Badge } from "@/components/ui/badge";
import type { ComponentDoc } from "@/lib/design-system/types";

function Variants() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge>Default</Badge>
      <Badge variant="secondary">Secondary</Badge>
      <Badge variant="muted">Muted</Badge>
      <Badge variant="outline">Outline</Badge>
      <Badge variant="destructive">Destructive</Badge>
      <Badge variant="success">Success</Badge>
      <Badge variant="warning">Warning</Badge>
      <Badge variant="info">Info</Badge>
    </div>
  );
}

const doc: ComponentDoc = {
  title: "Badge",
  purpose: "A small static label or status; for removable or clickable tags use Pill.",
  layer: "primitive",
  examples: [{ name: "Variants", Example: Variants }],
};
export default doc;
