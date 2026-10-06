import { Input } from "@/components/ui/input";
import type { ComponentDoc } from "@/lib/design-system/types";

function States() {
  return (
    <div className="grid gap-3 max-w-sm">
      <Input placeholder="Placeholder" />
      <Input defaultValue="AT61 1904 3002 3457 3201" />
      <Input disabled defaultValue="Disabled" />
      <Input aria-invalid defaultValue="Invalid" className="border-destructive" />
    </div>
  );
}

const doc: ComponentDoc = {
  title: "Input",
  purpose: "A single-line text field; for search with a clear button use SearchInput.",
  layer: "primitive",
  examples: [{ name: "States", Example: States }],
};
export default doc;
