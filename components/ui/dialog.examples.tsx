import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ComponentDoc } from "@/lib/design-system/types";

function Form() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">Rename account</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename account</DialogTitle>
          <DialogDescription>The new name shows on every transaction from this account.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="ds-dialog-name">Name</Label>
          <Input id="ds-dialog-name" defaultValue="Main Account" />
        </div>
        <DialogFooter>
          <Button>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const doc: ComponentDoc = {
  title: "Dialog",
  purpose: "A centred modal for a short task or form; for a yes/no confirmation use AlertDialog.",
  layer: "primitive",
  examples: [{ name: "Form in a dialog", Example: Form }],
};
export default doc;
