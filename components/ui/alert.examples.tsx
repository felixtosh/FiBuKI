import { AlertTriangle, Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { ComponentDoc } from "@/lib/design-system/types";

function Variants() {
  return (
    <div className="space-y-3 max-w-lg">
      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>Import finished</AlertTitle>
        <AlertDescription>124 transactions were added to Main Account.</AlertDescription>
      </Alert>
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Connection lost</AlertTitle>
        <AlertDescription>Reconnect the bank to keep importing.</AlertDescription>
      </Alert>
    </div>
  );
}

const doc: ComponentDoc = {
  title: "Alert",
  purpose: "An inline message box inside a page or panel; for a passing confirmation use SummaryToast.",
  layer: "primitive",
  examples: [{ name: "Variants", Example: Variants }],
};
export default doc;
