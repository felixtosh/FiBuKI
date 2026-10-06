import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { ComponentDoc } from "@/lib/design-system/types";

function Basic() {
  return (
    <Card className="max-w-sm">
      <CardHeader>
        <CardTitle>Gmail</CardTitle>
        <CardDescription>Receipts are searched in this mailbox.</CardDescription>
      </CardHeader>
      <CardContent className="text-sm">felix@example.com</CardContent>
      <CardFooter>
        <Button variant="outline" size="sm">Disconnect</Button>
      </CardFooter>
    </Card>
  );
}

const doc: ComponentDoc = {
  title: "Card",
  purpose: "A bordered box that groups one thing's content, e.g. an integration on a settings page.",
  layer: "primitive",
  examples: [{ name: "Basic", Example: Basic }],
};
export default doc;
