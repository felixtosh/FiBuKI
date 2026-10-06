import { InfoPopover } from "@/components/ui/info-popover";
import type { ComponentDoc } from "@/lib/design-system/types";

function Basic() {
  return (
    <div className="flex items-center gap-1 text-sm">
      Invoice
      <InfoPopover label="Why this is an Invoice">
        It names a seller, a buyer, a date and VAT, which is what § 11 UStG asks of an invoice.
      </InfoPopover>
    </div>
  );
}

const doc: ComponentDoc = {
  title: "InfoPopover",
  purpose: "An (i) icon next to a value that explains it in a popover.",
  layer: "pattern",
  examples: [{ name: "Basic", Example: Basic }],
};
export default doc;
