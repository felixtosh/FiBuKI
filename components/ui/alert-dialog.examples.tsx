import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { ComponentDoc } from "@/lib/design-system/types";

function Confirm() {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive">Delete bank account</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Main Account?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the account and all 1,204 of its transactions.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const doc: ComponentDoc = {
  title: "AlertDialog",
  purpose: "A blocking yes/no confirmation before a destructive or irreversible action.",
  layer: "primitive",
  examples: [{ name: "Confirm a delete", Example: Confirm }],
};
export default doc;
