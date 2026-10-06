import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ComponentDoc } from "@/lib/design-system/types";

function Basic() {
  return (
    <Tabs defaultValue="details" className="max-w-md">
      <TabsList>
        <TabsTrigger value="details">Details</TabsTrigger>
        <TabsTrigger value="files">Files</TabsTrigger>
        <TabsTrigger value="history">History</TabsTrigger>
      </TabsList>
      <TabsContent value="details" className="text-sm text-muted-foreground">Details content</TabsContent>
      <TabsContent value="files" className="text-sm text-muted-foreground">Files content</TabsContent>
      <TabsContent value="history" className="text-sm text-muted-foreground">History content</TabsContent>
    </Tabs>
  );
}

const doc: ComponentDoc = {
  title: "Tabs",
  purpose: "Switch between views of the same thing without leaving the page.",
  layer: "primitive",
  examples: [{ name: "Basic", Example: Basic }],
};
export default doc;
