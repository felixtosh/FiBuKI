import { AmountMatchDisplay } from "@/components/ui/amount-match-display";
import type { ComponentDoc } from "@/lib/design-system/types";

function States() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <AmountMatchDisplay count={1} countType="file" primaryAmount={-4990} primaryCurrency="EUR" secondaryAmounts={[{ amount: 4990, currency: "EUR" }]} />
      <AmountMatchDisplay count={1} countType="file" primaryAmount={-12000} primaryCurrency="EUR" secondaryAmounts={[{ amount: 10000, currency: "EUR" }]} />
      <AmountMatchDisplay count={2} countType="file" primaryAmount={-15000} primaryCurrency="EUR" secondaryAmounts={[{ amount: 10000, currency: "EUR" }, { amount: 5000, currency: "EUR" }]} />
      <AmountMatchDisplay count={1} countType="file" primaryAmount={-4990} primaryCurrency="EUR" secondaryAmounts={[{ amount: 4990, currency: "EUR" }]} warning="A payment confirmation, not an invoice" />
      <AmountMatchDisplay count={1} countType="file" primaryAmount={-4990} primaryCurrency="EUR" secondaryAmounts={[]} isExtracting />
    </div>
  );
}

const doc: ComponentDoc = {
  title: "AmountMatchDisplay",
  purpose: "The File/Transaction cell pill: how many are connected and whether their amounts add up.",
  layer: "pattern",
  examples: [{ name: "Match, difference, several, warning, extracting", Example: States }],
};
export default doc;
