import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ComponentDoc } from "@/lib/design-system/types";

function Basic() {
  return (
    <Select defaultValue="eur">
      <SelectTrigger className="w-48">
        <SelectValue placeholder="Currency" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="eur">EUR</SelectItem>
        <SelectItem value="usd">USD</SelectItem>
        <SelectItem value="chf">CHF</SelectItem>
      </SelectContent>
    </Select>
  );
}

const doc: ComponentDoc = {
  title: "Select",
  purpose: "Pick one value in a form; a list toolbar filter is a ChoiceFilter instead.",
  layer: "primitive",
  examples: [{ name: "Basic", Example: Basic }],
};
export default doc;
