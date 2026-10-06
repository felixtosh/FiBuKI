import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import type { ComponentDoc } from "@/lib/design-system/types";

function Sides() {
  return (
    <div className="flex flex-wrap gap-2">
      {(["right", "bottom"] as const).map((side) => (
        <Sheet key={side}>
          <SheetTrigger asChild>
            <Button variant="outline">Open from {side}</Button>
          </SheetTrigger>
          <SheetContent side={side}>
            <SheetHeader>
              <SheetTitle>All filters</SheetTitle>
              <SheetDescription>A bottom sheet is what a phone gets instead of a popover.</SheetDescription>
            </SheetHeader>
          </SheetContent>
        </Sheet>
      ))}
    </div>
  );
}

const doc: ComponentDoc = {
  title: "Sheet",
  purpose: "A panel that slides in from an edge; the phone form of a popover or side panel.",
  layer: "primitive",
  examples: [{ name: "Sides", Example: Sides }],
};
export default doc;
