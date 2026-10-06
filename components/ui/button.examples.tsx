import { Download, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ComponentDoc } from "@/lib/design-system/types";

function Variants() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button>Default</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="destructive">Destructive</Button>
      <Button variant="link">Link</Button>
    </div>
  );
}

function Sizes() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm">Small</Button>
      <Button>Default</Button>
      <Button size="lg">Large</Button>
      <Button size="icon" aria-label="Add">
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  );
}

function WithIcons() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button>
        <Plus className="h-4 w-4 mr-2" />
        Add account
      </Button>
      <Button variant="outline">
        <Download className="h-4 w-4 mr-2" />
        Export
      </Button>
      <Button variant="destructive">
        <Trash2 className="h-4 w-4 mr-2" />
        Delete
      </Button>
      <Button disabled>Disabled</Button>
    </div>
  );
}

const doc: ComponentDoc = {
  title: "Button",
  purpose: "Any clickable action; pick a variant and size instead of styling a raw <button>.",
  layer: "primitive",
  examples: [
    { name: "Variants", Example: Variants },
    { name: "Sizes", Example: Sizes },
    { name: "With icons", Example: WithIcons },
  ],
};
export default doc;
