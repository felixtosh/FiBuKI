import { FileText } from "lucide-react";
import { ConnectResultRow } from "@/components/ui/connect-result-row";
import type { ComponentDoc } from "@/lib/design-system/types";

function States() {
  return (
    <div className="max-w-md border rounded-md divide-y">
      <ConnectResultRow
        id="a"
        title="Rechnung 2026-031.pdf"
        date="15.03.2026"
        amount="-€49,90"
        amountType="negative"
        meta="234 KB"
        icon={<FileText className="h-4 w-4" />}
        isHighlighted
        highlightVariant="suggestion"
        confidence={92}
        matchSignals={["Amount", "Date", "Partner"]}
      />
      <ConnectResultRow
        id="b"
        title="Kunde GmbH"
        subtitle="Invoice 2026-12"
        date="12.03.2026"
        amount="€1.200,00"
        amountType="positive"
        connectionCount={1}
        connectionNoun="File"
        remainder="€200,00"
      />
      <ConnectResultRow id="c" title="Already connected" date="01.03.2026" amount="-€9,99" amountType="negative" isConnected />
      <ConnectResultRow id="d" title="Selected" date="02.03.2026" amount="-€19,00" amountType="negative" isSelected />
    </div>
  );
}

const doc: ComponentDoc = {
  title: "ConnectResultRow",
  purpose: "One candidate in the connect overlay's result list (a File or a Transaction to link).",
  layer: "pattern",
  examples: [{ name: "States", Example: States }],
};
export default doc;
